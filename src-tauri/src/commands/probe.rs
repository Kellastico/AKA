//! Per-session capability probe — the optional `--äkä-probe` handshake.
//!
//! Before a session's first run, AKA runs `<agent_bin> --äkä-probe` and reads a
//! single JSON capability object from stdout, within a 5 s budget. An agent that
//! answers (Änyä/Enyö) gets the rich treatment — model lock, stream panel,
//! host-driven phase routing — configured purely from what it advertised. An agent
//! that ignores the flag (times out, exits non-zero, or prints non-JSON) degrades
//! **silently** to a plain agent: no lock, no panel, the full annotated toolset,
//! self-driven. No error is surfaced. (OpenCode lands here cleanly.)
//!
//! This is the upfront, explicit half of the handshake. The in-band half — the
//! `@@aka {"announce":"capability-contract",…}` stdout marker the frontend parser
//! already consumes — remains a mid-stream fallback for agents that prefer not to
//! add a probe flag. Both feed the identical rule in [`crate::tools::mcp`].
//!
//! **House safety is identical whether the agent answers the probe or not.** The
//! probe configures *UI affordances and routing*; it never relaxes the sandbox,
//! the default-deny policy, or checkpoints. The probe is additive and
//! config-gated (`capabilities.probe`, default on): disabling it simply treats
//! every agent as a non-answerer.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::AppError;
use crate::sandbox::{assert_within_sandbox, SandboxState};
use crate::tools::mcp::{contract_from_probe, ContractMode};

/// The flag AKA passes to ask an agent to describe itself. Probe-aware agents
/// answer with one JSON object on stdout and exit; everyone else ignores it.
const PROBE_FLAG: &str = "--äkä-probe";

/// How long the agent has to answer before we treat it as a non-answerer. The
/// child is killed on drop, so a hung or interactive agent can't outlive this.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The capability object a probe-answering agent prints. Field names match the
/// agent's wire format **verbatim** (snake_case plus the kebab `capability-contract`)
/// so the same struct deserializes the agent's output and re-serializes to the
/// frontend unchanged. Every field defaults, so a partial object still parses.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProbe {
    /// Discriminant — must be `"agent"` for the object to count as an answer.
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    /// The agent owns its own LLM connection → AKA locks the model picker.
    #[serde(default)]
    pub manages_llm: bool,
    /// The agent emits a typed node/phase stream → AKA enables the stream panel.
    #[serde(default)]
    pub supports_streaming: bool,
    #[serde(default)]
    pub supports_dry_run: bool,
    #[serde(default)]
    pub required_args: Vec<String>,
    /// `"v1"` → host-driven phase routing + folder-keyed shadow/fallback.
    #[serde(default, rename = "capability-contract")]
    pub capability_contract: Option<String>,
    /// The agent's advertised capability folders. Retained verbatim for the
    /// folder-keyed shadow/fallback map; AKA never trusts it for enforcement.
    #[serde(default)]
    pub capability_folders: Vec<String>,
}

/// The result of probing one agent for a session. `answered` distinguishes a
/// rich (probe-answering) agent from a plain one; `contract` is always present
/// (it is the safe baseline when the agent didn't answer or isn't v1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// True only when the agent returned a valid `{"type":"agent",…}` object.
    pub answered: bool,
    /// `v1` (host-driven) or `mcp-baseline` (self-driven fallback). Drives Task 3.
    pub contract: ContractMode,
    /// The advertised capabilities — `None` for a non-answerer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<AgentProbe>,
}

impl ProbeResult {
    /// The silent-degrade result: a plain agent, baseline contract, no lock/panel.
    fn plain() -> Self {
        Self {
            answered: false,
            contract: ContractMode::McpBaseline,
            capabilities: None,
        }
    }

    fn answered(probe: AgentProbe) -> Self {
        let contract = contract_from_probe(probe.capability_contract.as_deref());
        Self {
            answered: true,
            contract,
            capabilities: Some(probe),
        }
    }
}

/// Parse a probe's stdout into an [`AgentProbe`]. Tries the whole output as one
/// JSON object first (the clean case), then falls back to the first line that
/// parses as a `{"type":"agent",…}` object — tolerating a banner or log lines
/// printed around the answer. Requiring `type == "agent"` keeps an unrelated JSON
/// blob (or a foreign agent's incidental JSON) from being mistaken for an answer.
fn parse_probe(stdout: &str) -> Option<AgentProbe> {
    let accept = |p: AgentProbe| (p.kind == "agent").then_some(p);
    if let Ok(p) = serde_json::from_str::<AgentProbe>(stdout.trim()) {
        if let Some(p) = accept(p) {
            return Some(p);
        }
    }
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{') && l.ends_with('}'))
        .find_map(|l| serde_json::from_str::<AgentProbe>(l).ok().and_then(accept))
}

/// Probe the project's configured agent for its capabilities. Never errors on a
/// non-answer — a timeout, crash, or garbage output all resolve to the silent
/// plain-agent result. Errors only on genuine misconfiguration (no sandbox / path
/// outside it / unconfigured agent bin), which the caller already handles.
#[tauri::command]
pub async fn probe_agent_capabilities(
    sandbox: tauri::State<'_, SandboxState>,
    project_path: String,
) -> Result<ProbeResult, AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::sandbox(project_path));
    }
    let sb = sandbox
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    assert_within_sandbox(std::path::Path::new(&project_path), &sb)?;

    let cfg = crate::commands::project_config::load_from_disk(&project_path).await?;
    // Config-gated and additive: when probing is off, every agent is a plain
    // agent. Nothing is spawned and no error is raised.
    if !cfg.capabilities.probe {
        return Ok(ProbeResult::plain());
    }
    let bin = cfg.agent.bin.clone();
    if bin.trim().is_empty() {
        // No agent to probe (the "None"/blank choice) — plain, no error.
        return Ok(ProbeResult::plain());
    }

    // Resolve the bin the way the user's terminal would (login-shell fallback),
    // off the async runtime since it may shell out.
    let bin_for_resolve = bin.clone();
    let program = tokio::task::spawn_blocking(move || {
        crate::path_env::resolve_bin(&bin_for_resolve)
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string_lossy().into_owned())
    .unwrap_or(bin);

    let mut command = Command::new(&program);
    command
        .arg(PROBE_FLAG)
        .current_dir(&project_path)
        // No stdin: an agent that ignores the flag and drops into a REPL gets an
        // immediate EOF instead of blocking until the timeout.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // A hung or interactive probe is killed when the future is dropped on
        // timeout — it can never outlive the 5 s budget.
        .kill_on_drop(true);

    let output = match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(out)) if out.status.success() => out,
        // Non-zero exit, spawn failure, or timeout → silently a plain agent.
        _ => return Ok(ProbeResult::plain()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_probe(&stdout).map_or_else(ProbeResult::plain, ProbeResult::answered))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANYA: &str = r#"{
        "type": "agent",
        "name": "Änyä",
        "manages_llm": true,
        "supports_streaming": true,
        "supports_dry_run": false,
        "required_args": [],
        "capability-contract": "v1",
        "capability_folders": ["read","write","search","process","git","context"]
    }"#;

    #[test]
    fn parses_a_full_anya_probe() {
        let p = parse_probe(ANYA).expect("valid probe");
        assert_eq!(p.kind, "agent");
        assert_eq!(p.name, "Änyä");
        assert!(p.manages_llm);
        assert!(p.supports_streaming);
        assert!(!p.supports_dry_run);
        assert_eq!(p.capability_contract.as_deref(), Some("v1"));
        assert_eq!(p.capability_folders.len(), 6);
    }

    #[test]
    fn full_probe_negotiates_v1_and_round_trips() {
        let result = ProbeResult::answered(parse_probe(ANYA).unwrap());
        assert!(result.answered);
        assert_eq!(result.contract, ContractMode::V1);
        // ProbeResult's own keys are camelCase; the nested AgentProbe keeps the
        // agent's verbatim field names (snake_case + the kebab contract key) so
        // the frontend reads exactly what the agent advertised.
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"answered\":true")); // ProbeResult → camelCase
        assert!(json.contains("\"manages_llm\":true")); // AgentProbe → verbatim
        assert!(json.contains("\"capability-contract\":\"v1\""));
    }

    #[test]
    fn finds_the_probe_among_banner_lines() {
        let noisy = format!("[enyö-änyä] starting up\nloaded 3 tools\n{}", ANYA.replace('\n', " "));
        let p = parse_probe(&noisy).expect("probe found past the banner");
        assert_eq!(p.name, "Änyä");
    }

    #[test]
    fn a_non_answer_is_none() {
        // Foreign agent help text, an unrelated JSON blob, and empty output all
        // fail to parse as a `{"type":"agent"}` object.
        assert!(parse_probe("usage: opencode [options] <task>").is_none());
        assert!(parse_probe(r#"{"status":"ok","tools":2}"#).is_none());
        assert!(parse_probe(r#"{"type":"server","name":"x"}"#).is_none());
        assert!(parse_probe("").is_none());
    }

    #[test]
    fn missing_contract_field_falls_back_to_baseline() {
        let p = parse_probe(r#"{"type":"agent","name":"Plainish","manages_llm":true}"#).unwrap();
        let result = ProbeResult::answered(p);
        // It answered (so it gets the lock from manages_llm), but without a v1
        // contract it self-drives under MCP-baseline routing.
        assert!(result.answered);
        assert_eq!(result.contract, ContractMode::McpBaseline);
        assert!(result.capabilities.unwrap().manages_llm);
    }

    #[test]
    fn plain_result_is_the_safe_default() {
        let plain = ProbeResult::plain();
        assert!(!plain.answered);
        assert_eq!(plain.contract, ContractMode::McpBaseline);
        assert!(plain.capabilities.is_none());
    }
}
