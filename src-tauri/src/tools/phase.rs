//! Deterministic, host-owned phase routing.
//!
//! The host computes which capability folders are "live" for the current phase
//! and exposes **only the `model_desc` of tools in those folders** to the model.
//! Because the model never sees a tool from a folder that isn't live, it cannot
//! mispick one — the surface is narrowed before the model ever reasons about it.
//! This is routing, not enforcement: even within a live folder, every call still
//! goes through [`super::policy`]. The table is data-driven and overridable per
//! project/profile.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::capability::Capability;
use super::registry::{ModelTool, Registry, ToolEntry};

/// A coding run's phase. Host-owned and deterministic — the model is told which
/// phase it is in; it does not get to widen its own folder set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Research,
    Plan,
    Edit,
    Review,
    Commit,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Research => "research",
            Phase::Plan => "plan",
            Phase::Edit => "edit",
            Phase::Review => "review",
            Phase::Commit => "commit",
        }
    }

    pub fn parse(s: &str) -> Option<Phase> {
        match s.trim().to_ascii_lowercase().as_str() {
            "research" => Some(Phase::Research),
            "plan" => Some(Phase::Plan),
            "edit" => Some(Phase::Edit),
            "review" => Some(Phase::Review),
            "commit" => Some(Phase::Commit),
            _ => None,
        }
    }

    /// The built-in live-folder table:
    ///
    /// | Phase    | Live folders        |
    /// |----------|---------------------|
    /// | RESEARCH | fs_read, search     |
    /// | PLAN     | fs_read             |
    /// | EDIT     | fs_read, fs_write   |
    /// | REVIEW   | fs_read             |
    /// | COMMIT   | git                 |
    fn default_folders(self) -> Vec<Capability> {
        match self {
            Phase::Research => vec![Capability::FsRead, Capability::Search],
            Phase::Plan => vec![Capability::FsRead],
            Phase::Edit => vec![Capability::FsRead, Capability::FsWrite],
            Phase::Review => vec![Capability::FsRead],
            Phase::Commit => vec![Capability::Git],
        }
    }
}

/// Per-project/profile overrides of the phase table, keyed by phase wire-name
/// (`"research"`, `"edit"`, …). An entry replaces that phase's live folders.
/// Routing only — overriding the *visible* surface can never grant privilege the
/// policy layer denies, so this is safe to be a full replacement rather than a
/// narrowing.
pub type PhaseOverrides = HashMap<String, Vec<Capability>>;

/// The folders live in `phase`, honoring any project override.
pub fn live_folders(phase: Phase, overrides: &PhaseOverrides) -> Vec<Capability> {
    overrides
        .get(phase.as_str())
        .cloned()
        .unwrap_or_else(|| phase.default_folders())
}

/// The model-facing tool surface for a phase: only the `model_desc` of registry
/// tools whose folder is live in this phase. The model literally cannot see a
/// tool from a non-live folder.
pub fn model_tools_for_phase(
    registry: &Registry,
    phase: Phase,
    overrides: &PhaseOverrides,
) -> Vec<ModelTool> {
    let live = live_folders(phase, overrides);
    registry
        .entries
        .iter()
        .filter(|e| live.contains(&e.folder))
        .map(ToolEntry::to_model_tool)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_table_matches_spec() {
        let none = PhaseOverrides::new();
        assert_eq!(
            live_folders(Phase::Research, &none),
            vec![Capability::FsRead, Capability::Search]
        );
        assert_eq!(live_folders(Phase::Plan, &none), vec![Capability::FsRead]);
        assert_eq!(
            live_folders(Phase::Edit, &none),
            vec![Capability::FsRead, Capability::FsWrite]
        );
        assert_eq!(live_folders(Phase::Review, &none), vec![Capability::FsRead]);
        assert_eq!(live_folders(Phase::Commit, &none), vec![Capability::Git]);
    }

    #[test]
    fn override_replaces_a_phase() {
        let mut ov = PhaseOverrides::new();
        ov.insert("edit".into(), vec![Capability::FsRead]); // lock EDIT to read-only
        assert_eq!(live_folders(Phase::Edit, &ov), vec![Capability::FsRead]);
        // Unaffected phases keep their defaults.
        assert_eq!(live_folders(Phase::Commit, &ov), vec![Capability::Git]);
    }

    #[test]
    fn phase_exposes_only_live_folder_descriptions() {
        let reg = Registry::from_builtins(); // diagnostics ∈ search
        let none = PhaseOverrides::new();
        // RESEARCH includes search → diagnostics is visible.
        let research = model_tools_for_phase(&reg, Phase::Research, &none);
        assert!(research.iter().any(|t| t.name == "diagnostics"));
        // COMMIT is git-only → diagnostics is NOT visible.
        let commit = model_tools_for_phase(&reg, Phase::Commit, &none);
        assert!(commit.iter().all(|t| t.name != "diagnostics"));
    }

    #[test]
    fn phase_serde_roundtrip() {
        assert_eq!(serde_json::to_string(&Phase::Edit).unwrap(), "\"edit\"");
        assert_eq!(Phase::parse("COMMIT"), Some(Phase::Commit));
        assert_eq!(Phase::parse("nope"), None);
    }
}
