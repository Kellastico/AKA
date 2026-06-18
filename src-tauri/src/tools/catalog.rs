//! The built-in tool catalog — AKA's overridable "pantry".
//!
//! Single source of truth for the *names and specs* of the tools AKA ships,
//! shared by the host and the `aka-tool` shim. The shim includes this file
//! directly (`#[path = "../tools/catalog.rs"] mod catalog;`) so the set of tool
//! names can never drift between what AKA advertises and what the shim can run.
//! Keep this file dependency-light (serde + std only) for that reason.

use serde::Serialize;

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
/// the manifest, the category it groups under, and how it runs.
#[derive(Debug, Clone, Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub usage: &'static str,
    pub category: &'static str,
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
        kind: ToolKind::Passthrough,
    }]
}
