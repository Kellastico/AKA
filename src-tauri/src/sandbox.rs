use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::sync::{oneshot, Mutex};

use crate::error::AppError;

/// Active sandbox boundary. The `project_path` is the canonical absolute root;
/// no file read, file write, or shell command may touch a path outside it.
#[derive(Debug, Clone)]
pub struct Sandbox {
    pub project_path: PathBuf,
}

impl Sandbox {
    fn new(project_path: PathBuf) -> Self {
        Self { project_path }
    }
}

#[derive(Default)]
pub struct SandboxState {
    inner: Mutex<Option<Sandbox>>,
}

impl SandboxState {
    pub async fn current(&self) -> Option<Sandbox> {
        self.inner.lock().await.clone()
    }

    pub async fn require(&self) -> Result<Sandbox, String> {
        self.inner
            .lock()
            .await
            .clone()
            .ok_or_else(|| "no active project sandbox".to_string())
    }

    pub async fn set(&self, sandbox: Sandbox) {
        *self.inner.lock().await = Some(sandbox);
    }

    pub async fn clear(&self) {
        *self.inner.lock().await = None;
    }
}

/// Resolve a path to its canonical absolute form. Walks up parents when the
/// path does not yet exist (e.g. file write targets), canonicalizing the
/// nearest existing ancestor so symlinks anywhere on the way to the target
/// still get resolved.
fn resolve_canonical(path: &Path) -> Result<PathBuf, String> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("cwd: {e}"))?
            .join(path)
    };

    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    let mut current = abs.clone();
    loop {
        match current.canonicalize() {
            Ok(mut canon) => {
                for seg in suffix.iter().rev() {
                    canon.push(seg);
                }
                return Ok(canon);
            }
            Err(_) => {
                let file = current
                    .file_name()
                    .ok_or_else(|| format!("cannot resolve {}", abs.display()))?
                    .to_os_string();
                let parent = current
                    .parent()
                    .ok_or_else(|| format!("cannot resolve {}", abs.display()))?
                    .to_path_buf();
                suffix.push(file);
                current = parent;
            }
        }
    }
}

/// Assert that `path` resolves to a location within `sandbox.project_path`.
/// Canonicalization defeats `..` traversal and symlinks that point out.
/// Returns `AppError::SandboxViolation` with the offending path so the UI
/// can surface a security event instead of a generic error string.
pub fn assert_within_sandbox(path: &Path, sandbox: &Sandbox) -> Result<(), AppError> {
    let resolved = resolve_canonical(path).map_err(|_| AppError::sandbox(path.display().to_string()))?;
    if resolved.starts_with(&sandbox.project_path) {
        Ok(())
    } else {
        Err(AppError::sandbox(resolved.display().to_string()))
    }
}

// ---------- Permission round-trip ----------

#[derive(Default)]
pub struct PermissionState {
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<bool>>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionRequest {
    id: u64,
    path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionResponse {
    id: u64,
    granted: bool,
}

const EVT_REQUEST: &str = "permission://request";
const EVT_RESPONSE: &str = "permission://response";

/// Register the single global listener for `permission://response` events.
/// Call this from `setup` so it lives for the duration of the app.
pub fn install_permission_listener(app: &AppHandle) {
    let app_clone = app.clone();
    app.listen(EVT_RESPONSE, move |event| {
        let Ok(resp) = serde_json::from_str::<PermissionResponse>(event.payload()) else {
            return;
        };
        let state = app_clone.state::<PermissionState>();
        let pending = state.pending.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(tx) = pending.lock().await.remove(&resp.id) {
                let _ = tx.send(resp.granted);
            }
        });
    });
}

/// Ask the user — via the frontend — to grant access to a path outside the
/// active project. Per-session only; never persisted.
#[tauri::command]
pub async fn request_path_access(
    app: AppHandle,
    perms: State<'_, PermissionState>,
    path: String,
) -> Result<bool, String> {
    let id = perms.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel::<bool>();
    perms.pending.lock().await.insert(id, tx);

    app.emit(EVT_REQUEST, PermissionRequest { id, path })
        .map_err(|e| format!("emit permission request: {e}"))?;

    match rx.await {
        Ok(granted) => Ok(granted),
        Err(_) => {
            perms.pending.lock().await.remove(&id);
            Ok(false)
        }
    }
}

// ---------- Sandbox lifecycle commands ----------

#[tauri::command]
pub async fn set_sandbox(
    state: State<'_, SandboxState>,
    project_path: String,
) -> Result<String, String> {
    if project_path.trim().is_empty() {
        return Err("project_path is required".into());
    }
    let canonical = resolve_canonical(Path::new(&project_path))?;
    if !canonical.is_dir() {
        return Err(format!(
            "project path is not a directory: {}",
            canonical.display()
        ));
    }
    state.set(Sandbox::new(canonical.clone())).await;
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn clear_sandbox(state: State<'_, SandboxState>) -> Result<(), String> {
    state.clear().await;
    Ok(())
}

#[tauri::command]
pub async fn current_sandbox(state: State<'_, SandboxState>) -> Result<Option<String>, String> {
    Ok(state
        .current()
        .await
        .map(|s| s.project_path.to_string_lossy().into_owned()))
}

// ---------- apply_diff ----------

/// Extract every file path referenced by a unified-diff patch. Skips
/// `/dev/null` markers (file create/delete sentinels) and strips the
/// conventional `a/` and `b/` prefixes.
fn extract_diff_paths(patch: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in patch.lines() {
        let raw = if let Some(rest) = line.strip_prefix("--- ") {
            rest
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            rest
        } else {
            continue;
        };
        // Strip trailing timestamps after a tab, common in unified diffs.
        let trimmed = raw.split('\t').next().unwrap_or(raw).trim();
        if trimmed == "/dev/null" || trimmed.is_empty() {
            continue;
        }
        let stripped = trimmed
            .strip_prefix("a/")
            .or_else(|| trimmed.strip_prefix("b/"))
            .unwrap_or(trimmed);
        if !stripped.is_empty() {
            out.push(stripped.to_string());
        }
    }
    out
}

/// Validate every path in `patch` against the active sandbox, then apply the
/// patch with `patch -p1`. The entire patch is rejected if any path escapes
/// the sandbox — no hunks are applied in that case.
#[tauri::command]
pub async fn apply_diff(
    state: State<'_, SandboxState>,
    patch: String,
    project_path: String,
) -> Result<(), String> {
    let sandbox = state
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()).to_string())?;

    let _cfg = crate::commands::project_config::load_from_disk(&project_path)
        .await
        .map_err(|e| e.to_string())?;

    // The caller-supplied project_path must match the active sandbox.
    assert_within_sandbox(Path::new(&project_path), &sandbox).map_err(|e| e.to_string())?;
    let project_root = resolve_canonical(Path::new(&project_path))?;
    if project_root != sandbox.project_path {
        return Err(AppError::sandbox(project_root.display().to_string()).to_string());
    }

    // Pre-flight: every referenced file must resolve inside the sandbox.
    let paths = extract_diff_paths(&patch);
    if paths.is_empty() {
        return Err("patch contains no file headers".into());
    }
    for rel in &paths {
        let candidate = project_root.join(rel);
        assert_within_sandbox(&candidate, &sandbox).map_err(|e| e.to_string())?;
    }

    // Write the patch to a temp file inside the sandbox so the `patch` binary
    // can consume it. Using the project root keeps everything in-bounds.
    let tmp = project_root.join(".äkä").join("tmp");
    tokio::fs::create_dir_all(&tmp)
        .await
        .map_err(|e| format!("mkdir {}: {}", tmp.display(), e))?;
    let tmp_file = tmp.join(format!(
        "patch-{}.diff",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    tokio::fs::write(&tmp_file, patch.as_bytes())
        .await
        .map_err(|e| format!("write patch: {e}"))?;

    let status = tokio::process::Command::new("patch")
        .arg("-p1")
        .arg("-i")
        .arg(&tmp_file)
        .current_dir(&project_root)
        .status()
        .await
        .map_err(|e| format!("spawn patch: {e}"))?;

    let _ = tokio::fs::remove_file(&tmp_file).await;

    if !status.success() {
        return Err(format!(
            "patch failed with exit code {}",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_outside_sandbox() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let sandbox = Sandbox::new(tmp.join("aka-test-root"));
        std::fs::create_dir_all(&sandbox.project_path).unwrap();

        let outside = tmp.join("elsewhere.txt");
        assert!(assert_within_sandbox(&outside, &sandbox).is_err());

        let inside = sandbox.project_path.join("ok.txt");
        assert!(assert_within_sandbox(&inside, &sandbox).is_ok());
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let root = tmp.join("aka-test-traverse");
        std::fs::create_dir_all(&root).unwrap();
        let sandbox = Sandbox::new(root.clone());

        let escape = root.join("..").join("escape.txt");
        assert!(assert_within_sandbox(&escape, &sandbox).is_err());
    }

    #[test]
    fn extracts_diff_paths() {
        let patch = "--- a/src/foo.rs\n+++ b/src/foo.rs\n@@\n-old\n+new\n--- /dev/null\n+++ b/new.txt\n";
        let paths = extract_diff_paths(patch);
        assert!(paths.contains(&"src/foo.rs".to_string()));
        assert!(paths.contains(&"new.txt".to_string()));
        assert!(!paths.iter().any(|p| p.contains("/dev/null")));
    }
}
