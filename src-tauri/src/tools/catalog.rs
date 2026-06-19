//! The built-in tool catalog — AKA's overridable "pantry".
//!
//! Single source of truth for the *names and specs* of the tools AKA ships,
//! shared by the host and the `aka-tool` shim. The shim includes this file
//! directly (`#[path = "../tools/catalog.rs"] mod catalog;`) so the set of tool
//! names can never drift between what AKA advertises and what the shim can run.
//! Keep this file dependency-light (serde + std only) for that reason.

use serde::{Deserialize, Serialize};

/// A capability "folder" — the privilege boundary a tool lands in. One level, no
/// nesting; the vocabulary is shared verbatim with the agent prompt. The serde
/// renames are load-bearing: `fs_read · fs_write · search · git · network · exec`
/// is the exact wire form both halves agree on.
///
/// This enum lives in `catalog.rs` (not `capability.rs`) on purpose: the
/// `aka-tool` shim `#[path]`-includes *only* this file, and `ToolSpec` now carries
/// a `folder`, so the type must be visible to the shim too. It is serde+std-only,
/// which keeps the catalog shim-safe. The annotation→folder *mapping* and the
/// per-folder policy live host-side (`tools::capability`, `tools::policy`) and are
/// never compiled into the shim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Read files within project scope.
    FsRead,
    /// Write files — default-deny outside the project root; checkpoint first.
    FsWrite,
    /// Read-only, scoped search/lookup (no mutation, no egress).
    Search,
    /// Version-control actions — approval-gated.
    Git,
    /// Outbound network — deny by default, allowlist only.
    Network,
    /// Arbitrary process execution — deny by default, explicit opt-in.
    Exec,
}

/// How a tool is executed.
// `Native` is constructed once the PDF tools land (final phase); allow it to sit
// unused until then rather than gate it behind a feature.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    /// Shells out to a user-configured command (e.g. `diagnostics`).
    Passthrough,
    /// Runs an engine built into the shim (e.g. the PDF tools, later).
    Native,
}

/// One advertisable tool: a stable name, a one-line usage spec the agent sees in
/// the manifest, the category it groups under, the capability `folder` (privilege
/// boundary) it belongs to, and how it runs.
#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub usage: &'static str,
    pub category: &'static str,
    /// SHORT model-facing signpost — the *only* description that reaches the model
    /// (via the registry's model-facing projection). Distinct from `usage`, which
    /// is the longer host/manifest/`TOOLS.md` form. Keep this to one clause.
    pub model_desc: &'static str,
    /// Privilege boundary this tool is routed/enforced under. House-owned tools
    /// self-classify by *effect*, not mechanism (see `diagnostics` below).
    pub folder: Capability,
    pub kind: ToolKind,
}

/// The full pantry AKA ships. The agent's own tools shadow these by name (see
/// `super::effective_tools`). The PDF tools join here in the final phase.
pub fn builtin_tools() -> Vec<ToolSpec> {
    vec![ToolSpec {
        name: "diagnostics",
        usage: "aka-tool diagnostics — run the project's configured typecheck/lint and \
                return structured {file,line,severity,message}",
        category: "diagnostics",
        model_desc: "Run the project's typecheck/lint and return structured findings.",
        // `Search`, not `Exec`: a House tool self-classifies by *effect*. Diagnostics
        // shells out to a configured linter, but the effect is read-only and scoped,
        // so it lives in `search` and stays usable in RESEARCH/REVIEW without forcing
        // the deny-by-default `exec` opt-in. The exec-of-a-trusted-command is the
        // House's own mechanism, not agent-driven execution.
        folder: Capability::Search,
        kind: ToolKind::Passthrough,
    }]
}
