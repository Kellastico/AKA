//! Tauri command surface for the agent compiler (see [`crate::compiler`]).
//! Thin by design: sandbox check, assemble the model catalog (local `.gguf`
//! fingerprints + the configured runtime's served-model list), then hand off
//! to the pure compile core on a blocking thread.

use std::path::Path;

use tauri::{AppHandle, State};

use crate::compiler::{CompileOutcome, ModelCatalog, ModelInfo};
use crate::sandbox::{assert_within_sandbox, SandboxState};

/// Local models with a size+mtime fingerprint — cheap, and enough to catch a
/// model file swapped under an unchanged name (full content hashing of
/// multi-GB GGUFs is not worth the latency at compile time).
fn local_models(models_dir: &Path) -> Vec<ModelInfo> {
    let Ok(entries) = std::fs::read_dir(models_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let id = e.file_name().into_string().ok()?;
            if !id.ends_with(".gguf") {
                return None;
            }
            let meta = e.metadata().ok();
            let fingerprint = meta
                .map(|m| {
                    let mtime = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    format!("sz{}-mt{}", m.len(), mtime)
                })
                .unwrap_or_default();
            Some(ModelInfo { id, fingerprint })
        })
        .collect()
}

/// Ask the project's configured runtime which models it serves. Delegates to
/// the same `llm::list_models` every model call already uses, so provider
/// detection, auth headers, and the OpenAI/Anthropic/Google list shapes are
/// handled in one place — a keyed endpoint no longer 401s and Google's
/// `{models:[…]}` shape parses. Best-effort: `None` on any failure so a flaky
/// network warns instead of blocking the compile.
async fn runtime_models(base_url: &str, api_key: Option<&str>) -> Option<Vec<String>> {
    crate::commands::llm::list_models(base_url.to_string(), api_key.map(str::to_string))
        .await
        .ok()
}

/// Compile a task spec file into a content-addressed artifact bundle under
/// `<project>/.äkä/compiled/`. Returns the outcome (bundle hash, manifest
/// path, per-node cached/generated status, pruned count) or a friendly
/// compile error.
#[tauri::command]
pub async fn compile_task_spec(
    app: AppHandle,
    sandbox: State<'_, SandboxState>,
    project_path: String,
    spec_path: String,
) -> Result<CompileOutcome, String> {
    if project_path.trim().is_empty() {
        return Err("project_path is required".into());
    }
    let sb = sandbox
        .require()
        .await
        .map_err(|_| format!("no sandbox is active for {project_path}"))?;
    assert_within_sandbox(Path::new(&project_path), &sb).map_err(|e| e.to_string())?;
    assert_within_sandbox(Path::new(&spec_path), &sb).map_err(|e| e.to_string())?;

    let spec_text = tokio::fs::read_to_string(&spec_path)
        .await
        .map_err(|e| format!("read spec {spec_path}: {e}"))?;

    let local = local_models(&crate::commands::models::models_dir(&app));
    // The runtime query targets the project's OWN configured endpoint — the
    // same one every model call already goes to, so no new egress surface.
    let remote = match crate::commands::project_config::load_from_disk(&project_path).await {
        Ok(cfg) => runtime_models(&cfg.runtime.base_url, cfg.runtime.api_key.as_deref()).await,
        Err(_) => None,
    };
    let catalog = ModelCatalog { local, remote };

    let project = std::path::PathBuf::from(&project_path);
    tokio::task::spawn_blocking(move || {
        crate::compiler::compile(&project, &spec_text, Some(&catalog)).map_err(|e| e.message)
    })
    .await
    .map_err(|e| format!("compile task panicked: {e}"))?
}
