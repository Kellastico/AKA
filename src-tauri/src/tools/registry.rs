//! Host-side tool registry — the source of truth for what tools exist, which
//! privilege folder each lives in, and (critically) the **split between what the
//! model sees and what the host keeps**.
//!
//! A [`ToolEntry`] carries everything the house needs to route and enforce a tool:
//! its folder, its scope policy, its owner (House vs Agent → trust + shadowing),
//! the raw MCP annotations (retained, never trusted), and a provenance `sha256`
//! (a forward hook for the Garden/Marketplace). **Only `model_desc` is ever sent
//! toward the model**, and that invariant is enforced *by type*: the model-facing
//! projection returns [`ModelTool`], a struct that physically cannot carry the
//! host-only fields. There is no `Serialize` path from `ToolEntry` to the model.

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::capability::{folder_from_annotations, Capability, McpAnnotations};

/// Who provides a tool. Drives both trust (Agent tools are untrusted, run only
/// under full house policy inside live-phase folders) and PATH-style shadowing
/// (a House implementation wins over an Agent's same-named tool unless config
/// explicitly allows the agent's).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolOwner {
    /// AKA's own built-in (the `aka-tool` pantry). Trusted-by-construction,
    /// sandboxed, self-classified by effect.
    House,
    /// A foreign agent's tool (consumed over MCP, phase 2). Untrusted by default.
    Agent,
}

/// The default-deny rules for a folder, materialized so the policy layer has a
/// flat descriptor to check against (rather than re-deriving from the enum each
/// time). Derived deterministically from [`Capability`] via [`Self::for_folder`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopePolicy {
    pub folder: Capability,
    /// Denied unless explicitly opened (allowlist / opt-in / approval).
    pub deny_by_default: bool,
    /// Gated behind explicit user approval (the `git` folder).
    pub requires_approval: bool,
    /// Filesystem paths must resolve inside the project root.
    pub project_scoped: bool,
    /// May mutate the filesystem (checkpoint-before-write applies).
    pub allows_write: bool,
    /// May make outbound network calls (allowlist-gated).
    pub allows_egress: bool,
    /// May spawn processes (opt-in gated).
    pub allows_exec: bool,
}

impl ScopePolicy {
    /// The canonical default-deny policy for a folder. This is the *baseline* the
    /// house enforces; a per-project config may only narrow it, never widen it
    /// (see [`super::policy::narrow`]).
    pub fn for_folder(folder: Capability) -> Self {
        let (project_scoped, allows_write, allows_egress, allows_exec) = match folder {
            Capability::FsRead => (true, false, false, false),
            Capability::Search => (true, false, false, false),
            Capability::FsWrite => (true, true, false, false),
            // Git acts on the repo (scoped) and moves refs (a write), but is the
            // approval-gated folder rather than a free write.
            Capability::Git => (true, true, false, false),
            Capability::Network => (false, false, true, false),
            Capability::Exec => (false, false, false, true),
        };
        Self {
            folder,
            deny_by_default: folder.deny_by_default(),
            requires_approval: folder.requires_approval(),
            project_scoped,
            allows_write,
            allows_egress,
            allows_exec,
        }
    }
}

/// One tool as the host knows it. Everything but `model_desc` is host-only — see
/// the module docs. `name` + `model_desc` are the model-facing pair; the rest is
/// routing, enforcement, trust, and provenance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolEntry {
    pub name: String,
    pub folder: Capability,
    /// SHORT signpost — the ONLY field that reaches the model.
    pub model_desc: String,
    pub scope_policy: ScopePolicy,
    pub requires_approval: bool,
    /// Provenance/content hash. Forward hook for the Garden/Marketplace filtering
    /// surface (folder + sha256 + hardware). Never used for enforcement.
    pub sha256: String,
    pub owner: ToolOwner,
    /// Raw MCP hints, retained for classification/observability — never trusted.
    pub annotations: McpAnnotations,
}

/// The model-facing projection of a tool. This is the *entire* surface the model
/// is allowed to see. It is a distinct type on purpose: there is no way to leak a
/// `scope_policy`, `sha256`, `owner`, or `annotations` through it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTool {
    pub name: String,
    pub model_desc: String,
}

impl ToolEntry {
    /// Project to the model-facing surface. The only sanctioned path from a
    /// `ToolEntry` toward the model.
    pub fn to_model_tool(&self) -> ModelTool {
        ModelTool {
            name: self.name.clone(),
            model_desc: self.model_desc.clone(),
        }
    }
}

/// SHA-256 over a tool's provenance string, hex-encoded. House tools hash their
/// shim identity; Agent tools hash their declared command/identity. A best-effort
/// forward hook — `""` is an acceptable value and is never enforced on.
fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    let digest = h.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// The host registry for one run/project: every tool the house knows about, House
/// built-ins first, foreign (Agent) tools appended as the MCP layer discovers them
/// (phase 2).
#[derive(Debug, Clone, Default, Serialize)]
pub struct Registry {
    pub entries: Vec<ToolEntry>,
}

impl Registry {
    /// Seed the registry with AKA's built-in pantry (House-owned). Folder and
    /// model_desc come straight from the shared catalog so they can't drift from
    /// what the shim runs.
    pub fn from_builtins() -> Self {
        let entries = super::catalog::builtin_tools()
            .into_iter()
            .map(|spec| {
                let folder = spec.folder;
                ToolEntry {
                    name: spec.name.to_string(),
                    folder,
                    model_desc: spec.model_desc.to_string(),
                    scope_policy: ScopePolicy::for_folder(folder),
                    requires_approval: folder.requires_approval(),
                    // House provenance: shim tool identity. (A future pass can
                    // hash the actual shim bytes; the name keeps it stable now.)
                    sha256: sha256_hex(&format!("house:aka-tool:{}", spec.name)),
                    owner: ToolOwner::House,
                    annotations: McpAnnotations::default(),
                }
            })
            .collect();
        Self { entries }
    }

    /// Append a foreign (Agent-owned) tool, classified from its MCP annotations.
    /// This is the exact seam the deferred MCP transport (phase 2) feeds: hand it
    /// a name, a model-facing description, and the raw annotations, and it lands in
    /// the right deny-by-default folder as untrusted.
    pub fn add_foreign(&mut self, name: &str, model_desc: &str, annotations: McpAnnotations) {
        self.entries
            .push(classify_foreign_tool(name, model_desc, annotations));
    }

    /// The model-facing projection of the whole registry — names + model_desc only.
    pub fn model_facing(&self) -> Vec<ModelTool> {
        self.entries.iter().map(ToolEntry::to_model_tool).collect()
    }

    /// All entries in a given folder (used by phase routing).
    pub fn in_folder(&self, folder: Capability) -> impl Iterator<Item = &ToolEntry> {
        self.entries.iter().filter(move |e| e.folder == folder)
    }
}

/// Classify a foreign tool into a [`ToolEntry`]: `owner: Agent`, folder derived
/// from its (untrusted) annotations, default-deny scope policy, annotations
/// retained. Pure — no IO — so the mapping is directly testable and the live
/// transport can reuse it verbatim.
pub fn classify_foreign_tool(
    name: &str,
    model_desc: &str,
    annotations: McpAnnotations,
) -> ToolEntry {
    let folder = folder_from_annotations(&annotations);
    ToolEntry {
        name: name.to_string(),
        folder,
        model_desc: model_desc.to_string(),
        scope_policy: ScopePolicy::for_folder(folder),
        requires_approval: folder.requires_approval(),
        sha256: sha256_hex(&format!("agent:{name}")),
        owner: ToolOwner::Agent,
        annotations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_facing_drops_all_host_only_fields() {
        let reg = Registry::from_builtins();
        let model = reg.model_facing();
        // Serialize the model-facing surface and prove host-only fields are absent.
        let json = serde_json::to_string(&model).unwrap();
        assert!(json.contains("modelDesc"));
        assert!(json.contains("diagnostics"));
        for leaked in ["scopePolicy", "sha256", "owner", "annotations", "folder"] {
            assert!(
                !json.contains(leaked),
                "host-only field `{leaked}` leaked into the model-facing projection"
            );
        }
    }

    #[test]
    fn builtins_carry_house_owner_and_folder() {
        let reg = Registry::from_builtins();
        let diag = reg
            .entries
            .iter()
            .find(|e| e.name == "diagnostics")
            .expect("diagnostics built-in present");
        assert_eq!(diag.owner, ToolOwner::House);
        assert_eq!(diag.folder, Capability::Search);
        assert!(!diag.sha256.is_empty());
    }

    #[test]
    fn foreign_tool_is_agent_owned_and_classified() {
        let ann = McpAnnotations {
            read_only_hint: Some(false),
            destructive_hint: Some(true),
            idempotent_hint: None,
            open_world_hint: Some(false),
        };
        let mut reg = Registry::from_builtins();
        reg.add_foreign("rm_rf", "delete a path", ann.clone());
        let e = reg.entries.iter().find(|e| e.name == "rm_rf").unwrap();
        assert_eq!(e.owner, ToolOwner::Agent);
        // destructive (not open-world) → fs_write, deny-by-default.
        assert_eq!(e.folder, Capability::FsWrite);
        assert!(e.scope_policy.deny_by_default);
        // Annotations retained verbatim, never consulted for the deny decision.
        assert_eq!(e.annotations, ann);
    }

    #[test]
    fn scope_policy_for_folder_is_default_deny() {
        let w = ScopePolicy::for_folder(Capability::FsWrite);
        assert!(w.deny_by_default && w.allows_write && w.project_scoped && !w.allows_egress);
        let n = ScopePolicy::for_folder(Capability::Network);
        assert!(n.deny_by_default && n.allows_egress && !n.project_scoped);
        let r = ScopePolicy::for_folder(Capability::FsRead);
        assert!(!r.deny_by_default && !r.allows_write && r.project_scoped);
        let g = ScopePolicy::for_folder(Capability::Git);
        assert!(g.requires_approval && g.deny_by_default);
    }
}
