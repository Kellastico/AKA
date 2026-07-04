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

    /// An anchored `apply_str_replace` could not be applied safely — the anchor
    /// was empty, missing, or ambiguous, or the target file was unreadable.
    /// `reason` is a precise, actionable message (e.g. "anchor matched 3 times").
    #[serde(rename_all = "camelCase")]
    EditConflict { reason: String },

    /// A cloud/remote LLM endpoint was called but isn't allowlisted. Egress is a
    /// `network` action and deny-by-default; `url` is the blocked base URL so the
    /// UI can offer "allow this endpoint" (add it to
    /// `capabilities.network_allowlist`).
    #[serde(rename_all = "camelCase")]
    NetworkBlocked { url: String },

    /// `summarize_session` timed out, errored, or produced an empty body.
    SummarizationFailed,

    /// The provider endpoint answered with a non-2xx status — an **API error**
    /// (invalid request, bad key, rate limit, provider-side failure). Distinct
    /// from `RuntimeOffline` (endpoint unreachable) and from agent/reasoning
    /// failures (`AgentCrash`, loop stop reasons): the runtime is up, the
    /// request reached it, and it said no. `message` is the provider's own
    /// error text, extracted from the response body.
    #[serde(rename_all = "camelCase")]
    ProviderRejected { status: u16, message: String },

    /// The MessageValidator removed every user/assistant message, so there was
    /// nothing valid to send. The request is refused client-side instead of
    /// letting a provider return "invalid message provided at index X".
    #[serde(rename_all = "camelCase")]
    InvalidConversation { reason: String },
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

    pub fn edit_conflict(reason: impl Into<String>) -> Self {
        Self::EditConflict {
            reason: reason.into(),
        }
    }

    pub fn network_blocked(url: impl Into<String>) -> Self {
        Self::NetworkBlocked { url: url.into() }
    }

    pub fn provider_rejected(status: u16, message: impl Into<String>) -> Self {
        Self::ProviderRejected {
            status,
            message: message.into(),
        }
    }

    pub fn invalid_conversation() -> Self {
        Self::InvalidConversation {
            reason: crate::commands::message_validator::EMPTY_CONVERSATION.to_string(),
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
            Self::EditConflict { reason } => write!(f, "edit conflict: {reason}"),
            Self::NetworkBlocked { url } => write!(f, "network egress blocked: {url}"),
            Self::SummarizationFailed => write!(f, "summarization failed"),
            Self::ProviderRejected { status, message } => {
                write!(f, "provider rejected request (HTTP {status}): {message}")
            }
            Self::InvalidConversation { reason } => {
                write!(f, "invalid conversation: {reason}")
            }
        }
    }
}

impl std::error::Error for AppError {}
