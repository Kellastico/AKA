use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::tools::phase::PhaseOverrides;
use crate::tools::policy::Limits;

const DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";
const DEFAULT_MODE: &str = "agent";
const DEFAULT_MAX_RETRIES: u32 = 3;

// Per-project config file: `<project>/.äkä/config.json`. The contents are the
// sole source of truth for which LLM, agent, mode, verify command, and retry
// limit a project uses. There is no global config — every setting is scoped
// to a project path.

fn default_base_url() -> String {
    DEFAULT_BASE_URL.to_string()
}

fn default_mode() -> String {
    DEFAULT_MODE.to_string()
}

fn default_max_retries() -> u32 {
    DEFAULT_MAX_RETRIES
}

fn default_true() -> bool {
    true
}

fn default_tools_mode() -> String {
    "advertise".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeBlock {
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Optional system prompt prepended to the built-in chat path (and exported
    /// to agents as `AKA_SYSTEM_PROMPT`). `None`/empty = none.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Sampling controls. `None` falls back to AKA's accuracy-leaning defaults
    /// (see `llm.rs`). Stored per project so each can be tuned independently.
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub top_p: Option<f32>,
    /// Explicit override of the vision-capability heuristic. `None` = auto-detect
    /// from the model id; `Some(true/false)` forces the answer.
    #[serde(default)]
    pub vision: Option<bool>,
}

impl Default for RuntimeBlock {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            model: String::new(),
            api_key: None,
            system_prompt: None,
            temperature: None,
            top_p: None,
            vision: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentBlock {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub bin: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub verify_cmd: String,
    /// Command the `diagnostics` built-in tool runs (typecheck/lint). Config-
    /// driven so it stays language-agnostic, mirroring `verify_cmd`. Empty = the
    /// tool reports "not configured" instead of running anything.
    #[serde(default)]
    pub diagnostics_cmd: String,
    /// Names of tools this agent already provides itself. AKA honors the agent's
    /// own tools first: in `gapfill` mode these names are dropped from the
    /// advertised manifest; in either mode they're reported as shadowed. Declared
    /// by the user — the agent never self-claims. See the `tools` module.
    #[serde(default)]
    pub provides_tools: Vec<String>,
    #[serde(default)]
    pub dry_run_flags: Vec<String>,
}

/// Per-project dev-server config — the command AKA runs when the user clicks
/// "Start" in a browser pane. Set once via the first-run prompt; persisted in
/// `.äkä/config.json` so subsequent starts are one-click. Empty `cmd` means
/// unconfigured: callers must prompt the user before spawning.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DevServerBlock {
    #[serde(default)]
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Project-level controls for AKA's built-in tool pantry (the overridable tool
/// set). The shim binary is always on PATH; this only governs whether and how
/// AKA *advertises* its tools to the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolsBlock {
    /// Master switch. Off = advertise nothing and set no `AKA_TOOLS`/manifest
    /// (the agent simply never hears about the pantry).
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// "advertise" = offer every built-in (the agent's own same-named tool still
    /// wins in its loop); "gapfill" = offer only names the agent didn't declare
    /// in `agent.provides_tools`.
    #[serde(default = "default_tools_mode")]
    pub mode: String,
}

impl Default for ToolsBlock {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: default_tools_mode(),
        }
    }
}

fn default_git_approval() -> bool {
    true
}

/// Per-project capability/privilege controls (the house layer's narrow-only knobs).
/// Every default is the **deny/safe** value: no network egress, no exec, git
/// approval-gated. A project may only *narrow* the deny-by-default baseline — these
/// fields opt specific targets in; they can never widen a folder open. Unset in an
/// existing config = full defaults (so old configs keep the safe posture).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilitiesBlock {
    /// Network destinations explicitly allowed (host, `host:port`, origin, or URL
    /// prefix). Empty = no outbound egress permitted (cloud models included).
    #[serde(default)]
    pub network_allowlist: Vec<String>,
    /// Process/tool names explicitly allowed to run under the `exec` folder.
    /// Empty = no exec permitted.
    #[serde(default)]
    pub exec_allow: Vec<String>,
    /// Whether `git`-folder actions require explicit user approval.
    #[serde(default = "default_git_approval")]
    pub git_requires_approval: bool,
    /// Optional per-phase live-folder overrides, keyed by phase wire-name
    /// (`"research"`, `"edit"`, …). `None` = use the built-in phase table.
    #[serde(default)]
    pub phase_overrides: Option<PhaseOverrides>,
    /// Tool names for which a foreign agent's own implementation is allowed to win
    /// over AKA's House built-in (PATH-style shadowing override). Empty = House
    /// always wins.
    #[serde(default)]
    pub tool_overrides: Vec<String>,
}

impl Default for CapabilitiesBlock {
    fn default() -> Self {
        Self {
            network_allowlist: Vec::new(),
            exec_allow: Vec::new(),
            git_requires_approval: true,
            phase_overrides: None,
            tool_overrides: Vec::new(),
        }
    }
}

impl CapabilitiesBlock {
    /// Distill the enforcement-relevant limits for the policy layer.
    pub fn limits(&self) -> Limits {
        Limits {
            network_allowlist: self.network_allowlist.clone(),
            exec_allow: self.exec_allow.clone(),
            git_requires_approval: self.git_requires_approval,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SandboxBlock {
    /// Informational only — the active sandbox is set from the opened project
    /// path, not from this field.
    #[serde(default)]
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectConfig {
    #[serde(default)]
    pub runtime: RuntimeBlock,
    #[serde(default)]
    pub agent: AgentBlock,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
    #[serde(default)]
    pub sandbox: SandboxBlock,
    #[serde(default)]
    pub dev_server: DevServerBlock,
    #[serde(default)]
    pub tools: ToolsBlock,
    #[serde(default)]
    pub capabilities: CapabilitiesBlock,
    /// Optional custom Task Envelope template (the structured wrapper AKA builds
    /// around the user's raw prompt for agent runs). `None` = use the built-in
    /// default template; "Reset to default" sets it back to `None`. The template
    /// text itself lives in the frontend (`task-envelope.ts`) — AKA only persists
    /// the user's override here.
    #[serde(default)]
    pub task_template: Option<String>,
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            runtime: RuntimeBlock::default(),
            agent: AgentBlock::default(),
            mode: DEFAULT_MODE.to_string(),
            max_retries: DEFAULT_MAX_RETRIES,
            sandbox: SandboxBlock::default(),
            dev_server: DevServerBlock::default(),
            tools: ToolsBlock::default(),
            capabilities: CapabilitiesBlock::default(),
            task_template: None,
        }
    }
}

pub fn config_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".äkä").join("config.json")
}

/// Load the project's config. Returns defaults if the file does not exist
/// (the file is created on the next save). Missing keys in an existing file
/// also fall back to their defaults — every field is `#[serde(default)]`.
///
/// An unreadable or unparseable file maps to `AppError::ConfigCorrupted`
/// rather than a generic string, so the UI can offer a "Reset to defaults"
/// action instead of silently swallowing the file.
pub async fn load_from_disk(project_path: &str) -> Result<ProjectConfig, AppError> {
    let path = config_path(project_path);
    if !path.exists() {
        return Ok(ProjectConfig::default());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::config_corrupted(format!("read {}: {}", path.display(), e)))?;
    if bytes.is_empty() {
        return Ok(ProjectConfig::default());
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| AppError::config_corrupted(format!("parse {}: {}", path.display(), e)))
}

#[tauri::command]
pub async fn load_config(project_path: String) -> Result<ProjectConfig, AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::config_corrupted("project_path is required"));
    }
    load_from_disk(&project_path).await
}

/// Atomic write: serialize → write to `config.json.tmp` in the same directory
/// → rename into place. A crash mid-write leaves either the old file intact
/// or the temp file as evidence; the canonical name is never partial.
#[tauri::command]
pub async fn save_config(
    project_path: String,
    config: ProjectConfig,
) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Err("project_path is required".into());
    }
    let path = config_path(&project_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let bytes =
        serde_json::to_vec_pretty(&config).map_err(|e| format!("serialize config: {e}"))?;

    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("rename {}: {}", path.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_json_falls_back_to_full_defaults() {
        // An empty `{}` should yield every field's default — no error.
        let cfg: ProjectConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg.runtime.base_url, DEFAULT_BASE_URL);
        assert_eq!(cfg.mode, DEFAULT_MODE);
        assert_eq!(cfg.max_retries, DEFAULT_MAX_RETRIES);
        assert!(cfg.agent.bin.is_empty());
    }

    #[test]
    fn partial_json_merges_over_defaults() {
        // Only `mode` set in the file — runtime/agent/max_retries default.
        let cfg: ProjectConfig = serde_json::from_str(r#"{"mode": "ask"}"#).unwrap();
        assert_eq!(cfg.mode, "ask");
        assert_eq!(cfg.runtime.base_url, DEFAULT_BASE_URL);
        assert_eq!(cfg.max_retries, DEFAULT_MAX_RETRIES);
    }
}
