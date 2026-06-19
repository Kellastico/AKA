//! Tool registry — AKA's overridable built-in pantry (feature #1) and the
//! PATH-style override/shadow resolution the manifest and UI build on
//! (feature #6). The catalog of tool *names* is shared with the `aka-tool` shim;
//! see [`catalog`].

pub mod capability;
pub mod catalog;
pub mod mcp;
pub mod phase;
pub mod policy;
pub mod registry;

use catalog::ToolSpec;
use registry::ToolOwner;
use serde::Serialize;

/// PATH-style override resolution: the effective pantry is every built-in whose
/// name the agent did NOT declare it already provides. The agent's own tool
/// always wins — AKA fills only the names left open. `declared` is the agent's
/// per-agent "tools it already provides" list (case-insensitive).
pub fn effective_tools(declared: &[String]) -> Vec<ToolSpec> {
    catalog::builtin_tools()
        .into_iter()
        .filter(|t| !declared.iter().any(|d| d.eq_ignore_ascii_case(t.name)))
        .collect()
}

/// Names of built-ins shadowed by the agent's declared tools — surfaced in the
/// UI ("N defaults overridden") so a swapped-in tool isn't a silent change.
pub fn shadowed_tools(declared: &[String]) -> Vec<&'static str> {
    catalog::builtin_tools()
        .into_iter()
        .filter(|t| declared.iter().any(|d| d.eq_ignore_ascii_case(t.name)))
        .map(|t| t.name)
        .collect()
}

/// House-first shadow resolution for a name both a House built-in and a foreign
/// agent provide (Task 6). The **house implementation wins** — scoped + enforced —
/// shadowing the agent's own, UNLESS `.äkä/config.json` explicitly names that tool
/// in `overrides`, in which case the agent-owned tool is allowed to win.
///
/// This inverts the manifest's gap-fill default (where the agent's tool wins by
/// name) on purpose: a foreign, untrusted agent's tool must not silently displace
/// a sandboxed House tool. `declared` is the agent's own tool names; a name not in
/// `declared` has no conflict and trivially resolves to House.
///
/// Pure + total. The phase-2 MCP dispatch is the live consumer; landing it now
/// pins the rule and keeps the existing native-agent manifest path untouched.
pub fn house_first_winner(name: &str, declared: &[String], overrides: &[String]) -> ToolOwner {
    let agent_provides = declared.iter().any(|d| d.eq_ignore_ascii_case(name));
    let config_allows_agent = overrides.iter().any(|o| o.eq_ignore_ascii_case(name));
    if agent_provides && config_allows_agent {
        ToolOwner::Agent
    } else {
        // No conflict, or conflict resolved house-first (the default).
        ToolOwner::House
    }
}

/// The advertisable tool manifest for one run — what AKA tells the agent it can
/// call, plus the names the agent's own tools shadow (for observability).
#[derive(Debug, Clone, Serialize)]
pub struct ToolManifest {
    /// Tools advertised to the agent this run (already filtered by `mode`).
    pub tools: Vec<ToolSpec>,
    /// Built-in names the agent declared it already provides — shadowed either
    /// way, surfaced so a swapped-in tool isn't a silent change.
    pub shadowed: Vec<&'static str>,
    /// "advertise" | "gapfill" — the mode that produced `tools`.
    pub mode: String,
    /// Whether the pantry is advertised at all.
    pub enabled: bool,
}

/// Build the manifest from the agent's declared tools and the project's mode.
/// `advertise` offers the whole pantry; `gapfill` offers only the open names.
/// `shadowed` is independent of mode — it's the name overlap, reported either way.
pub fn build_manifest(declared: &[String], mode: &str, enabled: bool) -> ToolManifest {
    let tools = if !enabled {
        Vec::new()
    } else if mode.eq_ignore_ascii_case("gapfill") {
        effective_tools(declared)
    } else {
        catalog::builtin_tools()
    };
    ToolManifest {
        tools,
        shadowed: if enabled { shadowed_tools(declared) } else { Vec::new() },
        mode: mode.to_string(),
        enabled,
    }
}

/// Render the manifest as the `.äkä/TOOLS.md` an instruction-reading agent can
/// pick up. Written into AKA's own dir (never the repo root) and regenerated
/// each run.
pub fn render_tools_md(m: &ToolManifest) -> String {
    let mut s = String::from("# AKA built-in tools\n\n");
    if !m.enabled || m.tools.is_empty() {
        s.push_str("_No AKA tools are advertised for this run._\n");
        return s;
    }
    s.push_str(
        "Provided by the host (AKA) and invoked via the `aka-tool` CLI, already on \
         your PATH. Each prints one JSON object on stdout. Use them when helpful; \
         your own same-named tools take precedence.\n\n",
    );
    for t in &m.tools {
        s.push_str(&format!("- **{}** — {}\n", t.name, t.usage));
    }
    if !m.shadowed.is_empty() {
        s.push_str(&format!(
            "\n_Your own tools take precedence for: {}._\n",
            m.shadowed.join(", ")
        ));
    }
    s
}

/// Effective manifest for a project — what `run_agent` advertises and the UI
/// shows. Reads the project config fresh (never cached).
#[tauri::command]
pub async fn tool_manifest(project_path: String) -> Result<ToolManifest, String> {
    let cfg = crate::commands::project_config::load_from_disk(&project_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(build_manifest(
        &cfg.agent.provides_tools,
        &cfg.tools.mode,
        cfg.tools.enabled,
    ))
}

/// Host-facing view of the tool registry for a project — the full [`registry::
/// ToolEntry`] list (folder, owner, scope policy, sha256, annotations). For the UI
/// only; this is *not* the model-facing surface. Currently the House built-in
/// pantry; foreign (Agent) tools join once the MCP transport lands (phase 2).
#[tauri::command]
pub async fn tool_registry(_project_path: String) -> Result<registry::Registry, String> {
    Ok(registry::Registry::from_builtins())
}

/// Model-facing tool surface for a given phase — **only** name + `model_desc` of
/// tools whose folder is live in that phase, honoring the project's optional
/// `capabilities.phase_overrides`. This is the deterministic, host-owned routing
/// the model is allowed to see.
#[tauri::command]
pub async fn phase_tools(
    project_path: String,
    phase: String,
) -> Result<Vec<registry::ModelTool>, String> {
    let cfg = crate::commands::project_config::load_from_disk(&project_path)
        .await
        .map_err(|e| e.to_string())?;
    let ph = phase::Phase::parse(&phase).ok_or_else(|| format!("unknown phase: {phase}"))?;
    let overrides = cfg.capabilities.phase_overrides.unwrap_or_default();
    let reg = registry::Registry::from_builtins();
    Ok(phase::model_tools_for_phase(&reg, ph, &overrides))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_tool_shadows_builtin_by_name() {
        let declared = vec!["diagnostics".to_string()];
        assert!(effective_tools(&declared)
            .iter()
            .all(|t| t.name != "diagnostics"));
        assert_eq!(shadowed_tools(&declared), vec!["diagnostics"]);
    }

    #[test]
    fn open_names_are_filled() {
        // The agent has its own read_file but no diagnostics — AKA still offers
        // diagnostics and shadows nothing.
        let declared = vec!["read_file".to_string()];
        assert!(effective_tools(&declared)
            .iter()
            .any(|t| t.name == "diagnostics"));
        assert!(shadowed_tools(&declared).is_empty());
    }

    #[test]
    fn shadowing_is_case_insensitive() {
        let declared = vec!["DIAGNOSTICS".to_string()];
        assert!(effective_tools(&declared).is_empty());
        assert_eq!(shadowed_tools(&declared), vec!["diagnostics"]);
    }

    #[test]
    fn no_declarations_offers_everything() {
        assert_eq!(effective_tools(&[]).len(), catalog::builtin_tools().len());
        assert!(shadowed_tools(&[]).is_empty());
    }

    #[test]
    fn advertise_mode_offers_all_but_still_flags_shadowed() {
        let declared = vec!["diagnostics".to_string()];
        let m = build_manifest(&declared, "advertise", true);
        assert!(m.tools.iter().any(|t| t.name == "diagnostics"));
        assert_eq!(m.shadowed, vec!["diagnostics"]);
    }

    #[test]
    fn gapfill_mode_drops_declared_names() {
        let declared = vec!["diagnostics".to_string()];
        let m = build_manifest(&declared, "gapfill", true);
        assert!(m.tools.iter().all(|t| t.name != "diagnostics"));
        assert_eq!(m.shadowed, vec!["diagnostics"]);
    }

    #[test]
    fn disabled_advertises_nothing() {
        let m = build_manifest(&[], "advertise", false);
        assert!(m.tools.is_empty());
        assert!(m.shadowed.is_empty());
    }

    #[test]
    fn tools_md_mentions_shim_and_shadowed() {
        let m = build_manifest(&["diagnostics".to_string()], "advertise", true);
        let md = render_tools_md(&m);
        assert!(md.contains("aka-tool"));
        assert!(md.contains("diagnostics"));
        assert!(md.contains("take precedence for"));
    }

    #[test]
    fn tools_md_when_disabled_is_explicit() {
        let m = build_manifest(&[], "advertise", false);
        let md = render_tools_md(&m);
        assert!(md.contains("No AKA tools"));
    }

    #[test]
    fn house_wins_unless_config_names_the_agent_tool() {
        let declared = vec!["diagnostics".to_string()];
        // No override → house wins even though the agent also provides it.
        assert_eq!(
            house_first_winner("diagnostics", &declared, &[]),
            ToolOwner::House
        );
        // Config explicitly allows the agent's tool to win.
        assert_eq!(
            house_first_winner("diagnostics", &declared, &["diagnostics".to_string()]),
            ToolOwner::Agent
        );
        // An override for a tool the agent doesn't even provide is a no-op → house.
        assert_eq!(
            house_first_winner("diagnostics", &[], &["diagnostics".to_string()]),
            ToolOwner::House
        );
    }
}
