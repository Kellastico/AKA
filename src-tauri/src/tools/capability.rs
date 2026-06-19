//! Capability folders — the privilege taxonomy and the MCP-annotation → folder
//! mapping (the agnostic interop seam).
//!
//! The [`Capability`] enum itself is declared in [`super::catalog`] so the
//! `aka-tool` shim (which includes only that file) can see it; this module
//! re-exports it and adds everything host-side: the raw MCP annotation hints, the
//! deterministic mapping from hints to folders, and the per-folder privilege
//! descriptors the house layer enforces.
//!
//! ## The one rule that matters
//!
//! MCP annotations are **untrusted hints** (mandated by the MCP spec). They are
//! retained on every [`super::registry::ToolEntry`] and used here only to
//! *classify and route* a tool into a folder. They are **never** the basis for a
//! security decision — [`super::policy`] enforces the folder's privilege boundary
//! regardless of what a hint claims. A tool that advertises `readOnlyHint: true`
//! and then tries to write is still blocked, because it lives in (or is checked
//! against) the `fs_write` boundary, not because of the hint.

use serde::{Deserialize, Serialize};

pub use super::catalog::Capability;

/// Standard MCP tool annotations, exactly as a foreign agent advertises them.
/// Every field is optional (a server may omit any), and all four are **hints
/// only** — retained for classification/observability, never trusted for
/// enforcement. See the module docs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAnnotations {
    /// The tool does not modify its environment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    /// The tool may perform destructive updates (only meaningful if not read-only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    /// Repeated calls with the same args have no additional effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    /// The tool interacts with an "open world" of external entities (network).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

impl McpAnnotations {
    fn flag(o: Option<bool>) -> bool {
        o.unwrap_or(false)
    }
}

/// Map standard MCP annotations onto a capability folder. **Classification only**
/// — the returned folder decides *routing* and *which deny-by-default policy*
/// applies, never trust. The precedence is deterministic and biased toward the
/// most-restricted bucket so an under-annotated foreign tool lands as untrusted:
///
/// | annotations                       | folder     |
/// |-----------------------------------|------------|
/// | openWorld **and** destructive     | `exec`     |
/// | destructive (not openWorld)       | `fs_write` |
/// | openWorld (not destructive)       | `network`  |
/// | readOnly                          | `search`   |
/// | none / unknown                    | `exec`     |
///
/// The `none/unknown → exec` default is the safety floor: a tool that tells us
/// nothing is treated as maximally untrusted (exec is deny-by-default), so it
/// can't slip into a permissive folder by simply omitting hints.
pub fn folder_from_annotations(a: &McpAnnotations) -> Capability {
    let read_only = McpAnnotations::flag(a.read_only_hint);
    let destructive = McpAnnotations::flag(a.destructive_hint);
    let open_world = McpAnnotations::flag(a.open_world_hint);

    match (open_world, destructive, read_only) {
        (true, true, _) => Capability::Exec,
        (false, true, _) => Capability::FsWrite,
        (true, false, _) => Capability::Network,
        (false, false, true) => Capability::Search,
        // Nothing actionable advertised → untrusted by default.
        (false, false, false) => Capability::Exec,
    }
}

impl Capability {
    /// Stable wire string (matches the serde rename + the agent-prompt vocabulary).
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::FsRead => "fs_read",
            Capability::FsWrite => "fs_write",
            Capability::Search => "search",
            Capability::Git => "git",
            Capability::Network => "network",
            Capability::Exec => "exec",
        }
    }

    /// Whether this folder is denied unless explicitly opened (allowlist / opt-in /
    /// approval). The read-only folders (`fs_read`, `search`) are allowed within
    /// scope; everything that can mutate, spend, or reach out is deny-by-default.
    pub fn deny_by_default(self) -> bool {
        match self {
            Capability::FsRead | Capability::Search => false,
            Capability::FsWrite | Capability::Git | Capability::Network | Capability::Exec => true,
        }
    }

    /// Whether a call in this folder is gated behind explicit user approval.
    /// `git` is the approval-gated folder; the rest are governed by scope,
    /// allowlist, or opt-in (see [`super::policy`]).
    pub fn requires_approval(self) -> bool {
        matches!(self, Capability::Git)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(read: Option<bool>, destr: Option<bool>, open: Option<bool>) -> McpAnnotations {
        McpAnnotations {
            read_only_hint: read,
            destructive_hint: destr,
            idempotent_hint: None,
            open_world_hint: open,
        }
    }

    #[test]
    fn capability_wire_strings_are_pinned() {
        // The vocabulary is a contract with the agent prompt — pin it exactly.
        assert_eq!(Capability::FsRead.as_str(), "fs_read");
        assert_eq!(Capability::FsWrite.as_str(), "fs_write");
        assert_eq!(Capability::Search.as_str(), "search");
        assert_eq!(Capability::Git.as_str(), "git");
        assert_eq!(Capability::Network.as_str(), "network");
        assert_eq!(Capability::Exec.as_str(), "exec");
        // serde agrees with as_str.
        assert_eq!(
            serde_json::to_string(&Capability::FsWrite).unwrap(),
            "\"fs_write\""
        );
        let back: Capability = serde_json::from_str("\"network\"").unwrap();
        assert_eq!(back, Capability::Network);
    }

    #[test]
    fn annotation_mapping_covers_every_rule() {
        // openWorld + destructive → exec (the most dangerous combination).
        assert_eq!(
            folder_from_annotations(&ann(Some(false), Some(true), Some(true))),
            Capability::Exec
        );
        // destructive only → fs_write.
        assert_eq!(
            folder_from_annotations(&ann(Some(false), Some(true), Some(false))),
            Capability::FsWrite
        );
        // openWorld only → network.
        assert_eq!(
            folder_from_annotations(&ann(Some(false), Some(false), Some(true))),
            Capability::Network
        );
        // readOnly → search.
        assert_eq!(
            folder_from_annotations(&ann(Some(true), Some(false), Some(false))),
            Capability::Search
        );
    }

    #[test]
    fn unknown_annotations_default_to_exec() {
        // A foreign tool that advertises nothing is maximally untrusted.
        assert_eq!(
            folder_from_annotations(&McpAnnotations::default()),
            Capability::Exec
        );
    }

    #[test]
    fn read_only_hint_does_not_grant_trust() {
        // A tool may *claim* readOnly, landing it in `search`. That folder is not
        // deny-by-default, but it also confers NO write/exec/network privilege —
        // the policy layer (tested in `policy`) blocks any write it attempts. This
        // test pins the classification half of that guarantee: a readOnly hint can
        // never put a tool into a writable folder.
        let folder = folder_from_annotations(&ann(Some(true), Some(true), Some(true)));
        // destructive+openWorld dominate the readOnly claim → exec, still denied.
        assert_eq!(folder, Capability::Exec);
        assert!(folder.deny_by_default());
    }

    #[test]
    fn deny_by_default_split_is_correct() {
        assert!(!Capability::FsRead.deny_by_default());
        assert!(!Capability::Search.deny_by_default());
        assert!(Capability::FsWrite.deny_by_default());
        assert!(Capability::Git.deny_by_default());
        assert!(Capability::Network.deny_by_default());
        assert!(Capability::Exec.deny_by_default());
        assert!(Capability::Git.requires_approval());
        assert!(!Capability::FsWrite.requires_approval());
    }
}
