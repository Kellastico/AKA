//! MCP interop seam — the agnostic way AKA consumes **foreign** agents/tools.
//!
//! **Phase-2 stub.** The enforcement core (registry, folders, per-folder policy,
//! phase routing, anchored edits) ships first; the live transport and the
//! capability-contract handshake land next. This module defines the *types and
//! the seam* so the rest of the system is already shaped for them — and so the
//! pure annotation→folder mapping ([`super::registry::classify_foreign_tool`])
//! has a documented home to plug into. Nothing here spawns a process yet; the
//! `negotiate` stub always reports the safe fallback.
//!
//! ## Local-first transport
//!
//! The default and only non-opt-in transport is **MCP over STDIO**: the foreign
//! agent is a local subprocess (consistent with the existing portable-pty/probe
//! model). A *remote* MCP server (Streamable HTTP) is opt-in only and is itself a
//! `network` action under the deny-by-default policy in [`super::policy`] — never
//! the default path. "Consume foreign agents over MCP" means *local* agents
//! speaking MCP first.

use serde::{Deserialize, Serialize};

/// How AKA reaches a foreign MCP server. STDIO (local subprocess) is the
/// local-first default; HTTP is opt-in and gated as a `network` action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum McpTransportKind {
    /// Local subprocess speaking MCP over stdin/stdout. The default.
    Stdio {
        /// The agent binary to spawn (resolved on PATH like every other agent).
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Remote MCP server (Streamable HTTP). Opt-in only; falls under the
    /// `network` deny-by-default policy — never auto-selected.
    Http { url: String },
}

/// A live (phase-2) MCP client. Defined now so callers can be written against the
/// seam; the implementation is deferred.
pub trait McpTransport {
    /// TODO(phase 2): connect, `initialize`, and `tools/list`, returning each
    /// foreign tool's name + description + raw annotations to feed straight into
    /// [`super::registry::Registry::add_foreign`].
    fn list_tools(&self) -> Result<Vec<ForeignToolDecl>, String>;
}

/// One tool as a foreign MCP server advertises it — the input to classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignToolDecl {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub annotations: super::capability::McpAnnotations,
}

/// Result of the probe handshake. Drives whether AKA can steer the agent's
/// phases/folders or must fall back to self-driving + MCP-baseline classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContractMode {
    /// The agent speaks `capability-contract: v1` → AKA drives its phases/folders.
    V1,
    /// The agent does not → fall back to MCP-baseline classification + default-deny
    /// and let the agent self-drive. AKA still enforces every call.
    McpBaseline,
}

/// The wire token AKA offers during the probe handshake.
pub const CONTRACT_V1: &str = "capability-contract: v1";

/// Negotiate the capability contract from a probe's advertised tokens.
///
/// **Phase-2 stub:** the live probe handshake isn't wired yet, so this returns the
/// safe fallback ([`ContractMode::McpBaseline`]) until an agent actually advertises
/// v1. The decision rule is already correct so the call sites don't change when the
/// transport lands.
pub fn negotiate(advertised: &[String]) -> ContractMode {
    if advertised.iter().any(|t| t == CONTRACT_V1) {
        ContractMode::V1
    } else {
        ContractMode::McpBaseline
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_agent_falls_back_to_baseline() {
        // A foreign agent that never heard of AKA → baseline (still enforced).
        assert_eq!(negotiate(&[]), ContractMode::McpBaseline);
        assert_eq!(
            negotiate(&["something-else".into()]),
            ContractMode::McpBaseline
        );
    }

    #[test]
    fn v1_agent_is_driven() {
        assert_eq!(negotiate(&[CONTRACT_V1.to_string()]), ContractMode::V1);
    }
}
