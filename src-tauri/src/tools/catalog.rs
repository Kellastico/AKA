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
    /// Exposed to **external agents** via the `aka-tool` CLI shim (advertised in
    /// `AKA_TOOLS`/`TOOLS.md`, runnable as `aka-tool <name>`). Only set when the
    /// shim binary actually implements the subcommand, so we never advertise a
    /// tool an agent can't run.
    pub shim: bool,
    /// Exposed to the **built-in native-tool-calling loop** (the model AKA drives)
    /// via `builtin_tool_defs`, executed through the host's enforced path. This is
    /// the model-facing surface; both surfaces draw from this one catalog.
    pub native: bool,
}

/// The full pantry AKA ships — the **single source of truth** for every built-in
/// tool. Each entry declares its privilege `folder` plus which surface(s) expose
/// it: `shim` (external agents, via the `aka-tool` CLI) and/or `native` (the
/// built-in loop, via `builtin_tool_defs`). Both surfaces project from this one
/// list; the agent's own tools shadow these by name (see `super::effective_tools`).
///
/// The `fs_write` tools (`str_replace`/`apply_diff`/`delete_file`) map to AKA's
/// enforced edit commands (`sandbox::apply_str_replace`/`apply_diff`/`delete_file`),
/// so the scope + checkpoint + approval + witness rules are baked into execution
/// wherever AKA runs the tool — the model can only reach them through that path.
pub fn builtin_tools() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "diagnostics",
            usage: "aka-tool diagnostics — run the project's configured typecheck/lint and \
                    return structured {file,line,severity,message}",
            category: "diagnostics",
            model_desc: "Run the project's typecheck/lint and return structured findings.",
            // `Search`, not `Exec`: a House tool self-classifies by *effect*. Diagnostics
            // shells out to a configured linter, but the effect is read-only and scoped,
            // so it lives in `search` and stays usable in RESEARCH/REVIEW without forcing
            // the deny-by-default `exec` opt-in.
            folder: Capability::Search,
            kind: ToolKind::Passthrough,
            shim: true,
            // Also exposed to the built-in loop: Strategize gives the model
            // read + diagnose. Execution shells out to the user-configured
            // diagnostics_cmd — House-trusted, read-only by effect.
            native: true,
        },
        ToolSpec {
            name: "capture-window",
            usage: "aka-tool capture-window [--out <path>] [--window <title>] — capture AKA's \
                    own window to a PNG and return {path,kind:\"image\",width,height}",
            category: "capture",
            model_desc: "Capture a screenshot of AKA's window and return the image path.",
            // `Exec`, not `fs_write`: a House tool self-classifies by *effect*, and
            // effect here is reading the whole display — off-project pixels that can
            // hold secrets from other apps — behind an OS permission prompt. That's
            // the maximally-untrusted floor, so it lives in the deny-by-default `exec`
            // folder and is opt-in only (`capabilities.exec_allow` names it). The
            // shim self-gates against that list before it ever captures (it can't
            // link the host policy layer). Placing it in `fs_write` would understate
            // the screen-read and force the PNG into project scope; `exec`'s opt-in
            // lets the capture land in a temp dir instead.
            folder: Capability::Exec,
            // Runs an engine built into the shim (xcap), not a user command.
            kind: ToolKind::Native,
            shim: true,
            // Not exposed to the built-in native loop — this is an agent-facing
            // capture tool, surfaced via the `aka-tool` CLI only.
            native: false,
        },
        ToolSpec {
            name: "read_file",
            usage: "read_file {path, offset?, limit?} — read a UTF-8 text file within the project (paged)",
            category: "fs",
            model_desc: "Read a text file within the project; use offset/limit to page big files.",
            folder: Capability::FsRead,
            kind: ToolKind::Native,
            shim: false,
            native: true,
        },
        ToolSpec {
            name: "list_dir",
            usage: "list_dir {path?} — list a directory within the project",
            category: "fs",
            model_desc: "List the entries of a directory within the project.",
            folder: Capability::Search,
            kind: ToolKind::Native,
            shim: false,
            native: true,
        },
        ToolSpec {
            name: "search_files",
            usage: "search_files {query, path?} — substring search over project files",
            category: "search",
            model_desc: "Search project files for a substring; returns path:line matches.",
            folder: Capability::Search,
            kind: ToolKind::Native,
            shim: false,
            native: true,
        },
        ToolSpec {
            name: "str_replace",
            usage: "str_replace {path, old_str, new_str} — anchored single-occurrence edit",
            category: "fs",
            model_desc: "Replace one exact snippet in a file (anchored edit).",
            folder: Capability::FsWrite,
            kind: ToolKind::Native,
            shim: false,
            native: true,
        },
        ToolSpec {
            name: "apply_diff",
            usage: "apply_diff {patch} — apply a unified diff to project files",
            category: "fs",
            model_desc: "Apply a unified diff to files within the project.",
            folder: Capability::FsWrite,
            kind: ToolKind::Native,
            shim: false,
            native: true,
        },
        ToolSpec {
            name: "delete_file",
            usage: "delete_file {path} — delete a file (approval-gated)",
            category: "fs",
            model_desc: "Delete a file within the project (requires approval).",
            folder: Capability::FsWrite,
            kind: ToolKind::Native,
            shim: false,
            native: true,
        },
    ]
}

/// Tools exposed to **external agents** via the `aka-tool` shim (the agent-facing
/// projection of the catalog). Filtered by the `shim` flag so agents are only ever
/// advertised subcommands the shim actually implements.
pub fn shim_tools() -> Vec<ToolSpec> {
    builtin_tools().into_iter().filter(|t| t.shim).collect()
}
