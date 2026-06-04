//! Local model file management for the built-in runtime.
//!
//! Models are `.gguf` files stored in the platform app-data directory
//! (`app_data_dir()/models`), never inside a project. All filesystem access
//! goes through these Tauri commands — the frontend never touches the disk
//! directly. Downloads stream from HuggingFace with cancellable progress.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

const EVT_PROGRESS: &str = "model:download-progress";
const EVT_COMPLETE: &str = "model:download-complete";
const EVT_ERROR: &str = "model:download-error";

/// Emit a progress event at most this often (by bytes) to avoid flooding the
/// event bus on fast connections.
const PROGRESS_STEP_BYTES: u64 = 1024 * 1024; // 1 MiB

/// The canonical models directory: `<app_data_dir>/models`. Shared with the
/// sidecar launcher so both agree on where models live.
pub fn models_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("models")
}

/// In-flight download cancellation flags, keyed by target filename.
#[derive(Default)]
pub struct DownloadState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub filename: String,
    pub size_bytes: u64,
    /// Minimum RAM to safely load, in GB. `None` for file-imported / scanned
    /// models — unknown until GGUF metadata is parsed (Step 7). Curated models
    /// populate this from their manifest.
    pub min_ram_gb: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    filename: String,
    bytes_downloaded: u64,
    total_bytes: u64,
    percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletePayload {
    filename: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    filename: String,
    error: String,
}

/// RAII cleanup for the `.part` download file: removes it on drop unless
/// `commit()` was called. This covers every early exit — `?` propagation,
/// explicit `return Err`, cancellation, and panics — so a failed download
/// never leaves an orphaned partial file behind. `commit()` is called only
/// after the successful rename into place.
struct PartFileGuard {
    path: PathBuf,
    committed: bool,
}

impl PartFileGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }
    fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for PartFileGuard {
    fn drop(&mut self) {
        if !self.committed && self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Validate that `path` is a real GGUF file by its magic bytes (0–3 == "GGUF")
/// and a plausible minimum size. Rejects junk/incomplete files at the import
/// door so they never reach the models directory (and later, llama.cpp).
fn is_valid_gguf(path: &std::path::Path) -> bool {
    use std::io::Read;
    const GGUF_MAGIC: [u8; 4] = [0x47, 0x47, 0x55, 0x46]; // "GGUF"
    const MIN_VALID_SIZE: u64 = 16;

    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if metadata.len() < MIN_VALID_SIZE {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 4];
    matches!(file.read_exact(&mut magic), Ok(())) && magic == GGUF_MAGIC
}

/// Reject filenames that could escape the models directory. Only a bare
/// filename is ever accepted — no separators, no parent refs.
fn safe_filename(filename: &str) -> Result<&str, String> {
    let trimmed = filename.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(format!("invalid filename: {filename:?}"));
    }
    Ok(trimmed)
}

/// List the `.gguf` files currently in the models directory.
#[tauri::command]
pub async fn list_local_models(app: AppHandle) -> Vec<LocalModel> {
    let dir = models_dir(&app);
    let mut out = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return out;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let is_gguf = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false);
        if !is_gguf {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let size_bytes = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
        out.push(LocalModel {
            filename: name.to_string(),
            size_bytes,
            min_ram_gb: None,
        });
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    out
}

/// Import an arbitrary local `.gguf` into the models directory by copying it
/// in. Returns the destination filename. Used by the "Add from file" picker —
/// such models are flagged unverified in the UI.
#[tauri::command]
pub async fn import_model(app: AppHandle, src_path: String) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    let is_gguf = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err("not a .gguf file".into());
    }
    if !is_valid_gguf(&src) {
        return Err(
            "The selected file is not a valid GGUF model. It may be corrupt or incomplete."
                .to_string(),
        );
    }
    let raw_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid source path".to_string())?;
    let name = safe_filename(raw_name)?.to_string();
    let dir = models_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let dest = dir.join(&name);
    tokio::fs::copy(&src, &dest)
        .await
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest.display()))?;
    Ok(name)
}

/// Delete a downloaded model file.
#[tauri::command]
pub async fn delete_model(app: AppHandle, filename: String) -> Result<(), String> {
    let name = safe_filename(&filename)?;
    let path = models_dir(&app).join(name);
    if !path.exists() {
        return Ok(());
    }
    tokio::fs::remove_file(&path)
        .await
        .map_err(|e| format!("delete {}: {e}", path.display()))
}

/// Cancel an in-progress download. Returns true if a matching download was
/// running.
#[tauri::command]
pub async fn cancel_download(
    filename: String,
    state: State<'_, DownloadState>,
) -> Result<bool, String> {
    let guard = state.cancels.lock().await;
    if let Some(flag) = guard.get(&filename) {
        flag.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Stream a `.gguf` from HuggingFace into the models directory.
///
/// Emits `model:download-progress` as bytes arrive, `model:download-complete`
/// on success, and `model:download-error` on any failure (including
/// cancellation, which is reported with error `"cancelled"`). The partial
/// file is written to `<name>.part` and only renamed into place once the full
/// download succeeds, so an interrupted download never looks complete.
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    repo: String,
    filename: String,
    state: State<'_, DownloadState>,
) -> Result<(), String> {
    let name = safe_filename(&filename)?.to_string();
    let dir = models_dir(&app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    // Register a cancellation flag for this download.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = state.cancels.lock().await;
        guard.insert(name.clone(), cancel.clone());
    }

    let result = run_download(&app, &repo, &name, &dir, &cancel).await;

    // Always deregister the flag.
    {
        let mut guard = state.cancels.lock().await;
        guard.remove(&name);
    }

    match result {
        Ok(()) => {
            let _ = app.emit(EVT_COMPLETE, CompletePayload { filename: name });
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                EVT_ERROR,
                ErrorPayload {
                    filename: name,
                    error: e.clone(),
                },
            );
            Err(e)
        }
    }
}

async fn run_download(
    app: &AppHandle,
    repo: &str,
    name: &str,
    dir: &PathBuf,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        repo.trim_matches('/'),
        name
    );

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {url}", resp.status()));
    }

    let total_bytes = resp.content_length().unwrap_or(0);

    // Disk-space pre-check when the server reported a size. If Content-Length
    // is absent (total_bytes == 0) we skip it and rely on write-error cleanup.
    if total_bytes > 0 {
        let available = fs2::available_space(dir).unwrap_or(u64::MAX);
        if total_bytes > available {
            return Err(format!(
                "Not enough disk space. Download requires {:.1}GB, only {:.1}GB available.",
                total_bytes as f64 / 1_073_741_824.0,
                available as f64 / 1_073_741_824.0
            ));
        }
    }

    let part_path = dir.join(format!("{name}.part"));
    let final_path = dir.join(name);

    // Removes `part_path` on any early return (error/cancel/panic) until the
    // successful rename calls `commit()`.
    let part_guard = PartFileGuard::new(part_path.clone());

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("create {}: {e}", part_path.display()))?;

    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err("cancelled".into());
        }
        let bytes = chunk.map_err(|e| format!("stream: {e}"))?;
        file.write_all(&bytes)
            .await
            .map_err(|e| format!("write: {e}"))?;
        downloaded += bytes.len() as u64;

        if downloaded - last_emit >= PROGRESS_STEP_BYTES {
            last_emit = downloaded;
            let percent = if total_bytes > 0 {
                (downloaded as f64 / total_bytes as f64) * 100.0
            } else {
                0.0
            };
            let _ = app.emit(
                EVT_PROGRESS,
                ProgressPayload {
                    filename: name.to_string(),
                    bytes_downloaded: downloaded,
                    total_bytes,
                    percent,
                },
            );
        }
    }

    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    drop(file);

    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| format!("finalize {}: {e}", final_path.display()))?;
    // Renamed into place — keep the (now-renamed) file; don't let the guard
    // delete it.
    part_guard.commit();

    // Final 100% progress so the UI snaps to complete.
    let _ = app.emit(
        EVT_PROGRESS,
        ProgressPayload {
            filename: name.to_string(),
            bytes_downloaded: downloaded,
            total_bytes: if total_bytes == 0 { downloaded } else { total_bytes },
            percent: 100.0,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_filename;

    #[test]
    fn accepts_bare_gguf_name() {
        assert_eq!(safe_filename("qwen2.5-coder-7b-q4.gguf").unwrap(), "qwen2.5-coder-7b-q4.gguf");
        assert_eq!(safe_filename("  model.gguf  ").unwrap(), "model.gguf");
    }

    #[test]
    fn rejects_traversal_and_separators() {
        assert!(safe_filename("../secret").is_err());
        assert!(safe_filename("sub/dir.gguf").is_err());
        assert!(safe_filename("a\\b.gguf").is_err());
        assert!(safe_filename("..").is_err());
        assert!(safe_filename("").is_err());
        assert!(safe_filename("   ").is_err());
    }
}
