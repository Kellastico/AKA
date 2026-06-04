use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeBlock {
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

impl Default for RuntimeBlock {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            model: String::new(),
            api_key: None,
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
