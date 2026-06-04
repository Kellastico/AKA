use serde::Serialize;

/// Tagged enum serialised straight to the frontend across IPC. Every variant
/// carries enough context for the UI to render a specific, actionable
/// message — never a generic "something went wrong." The frontend maps the
/// `kind` discriminator to a human-readable banner; raw Rust strings are
/// never shown to the user.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum AppError {
    /// LLM endpoint unreachable (connect failure or timeout).
    RuntimeOffline,

    /// No coding agents found on this machine. Constructed on the TS side
    /// from `detect_agents()` results; included here so the enum stays the
    /// single source of truth for error shapes.
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    NoAgentsInstalled { hints: Vec<String> },

    /// Agent process exited with a non-zero status. `stderr` is the last 20
    /// lines printed to stderr before the process died.
    #[serde(rename_all = "camelCase")]
    AgentCrash { exit_code: i32, stderr: String },

    /// `verify_cmd`'s binary could not be resolved in PATH. `cmd` is the full
    /// verify_cmd string from `.äkä/config.json`.
    #[serde(rename_all = "camelCase")]
    VerifyCommandNotFound { cmd: String },

    /// Attempt to touch a path outside the active project sandbox.
    #[serde(rename_all = "camelCase")]
    SandboxViolation { path: String },

    /// `.äkä/config.json` could not be parsed. `reason` is the parse error.
    #[serde(rename_all = "camelCase")]
    ConfigCorrupted { reason: String },

    /// `summarize_session` timed out, errored, or produced an empty body.
    SummarizationFailed,
}

impl AppError {
    pub fn sandbox(path: impl Into<String>) -> Self {
        Self::SandboxViolation { path: path.into() }
    }

    pub fn config_corrupted(reason: impl Into<String>) -> Self {
        Self::ConfigCorrupted {
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RuntimeOffline => write!(f, "LLM runtime offline"),
            Self::NoAgentsInstalled { .. } => write!(f, "no coding agents installed"),
            Self::AgentCrash { exit_code, .. } => {
                write!(f, "agent crashed with exit code {exit_code}")
            }
            Self::VerifyCommandNotFound { cmd } => write!(f, "verify command not found: {cmd}"),
            Self::SandboxViolation { path } => write!(f, "blocked by sandbox: {path}"),
            Self::ConfigCorrupted { reason } => write!(f, "config corrupted: {reason}"),
            Self::SummarizationFailed => write!(f, "summarization failed"),
        }
    }
}

impl std::error::Error for AppError {}
