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

/// Normalize and validate a HuggingFace repo reference into a bare `owner/name`
/// id. Accepts either `owner/name` or a pasted `https://huggingface.co/owner/name`
/// URL (with optional `/tree/...`, `/resolve/...`, `/blob/...` suffix).
///
/// This is the host-pinning guard: the result is only ever interpolated into a
/// `https://huggingface.co/...` URL, so we reject anything that isn't a clean
/// two-segment id of safe characters. That makes it impossible for a pasted
/// value to redirect a fetch off-host or traverse the API path (`..`).
fn normalize_repo(input: &str) -> Result<String, String> {
    let mut s = input.trim();

    // Strip a pasted huggingface.co URL down to its path.
    for prefix in [
        "https://huggingface.co/",
        "http://huggingface.co/",
        "https://www.huggingface.co/",
        "huggingface.co/",
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest;
            break;
        }
    }
    // A pasted URL may carry the host on a different scheme/host — reject those
    // outright rather than silently treating them as a repo path.
    if s.contains("://") {
        return Err("Only huggingface.co repositories are supported".into());
    }

    // Keep just `owner/name`. Any tail must be a recognized git-ref route
    // (`/tree/...`, `/resolve/...`, `/blob/...`) from a pasted URL — anything
    // else (e.g. a stray `host/owner/name`) is rejected rather than silently
    // truncated to the wrong repo.
    let segs: Vec<&str> = s.trim_matches('/').split('/').collect();
    let owner = segs.first().copied().unwrap_or("");
    let name = segs.get(1).copied().unwrap_or("");

    let valid_seg = |seg: &str| {
        !seg.is_empty()
            && seg != ".."
            && seg != "."
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !valid_seg(owner) || !valid_seg(name) {
        return Err(format!("Invalid HuggingFace repo: {input:?}"));
    }
    if let Some(route) = segs.get(2) {
        if !matches!(*route, "tree" | "resolve" | "blob" | "raw" | "commit") {
            return Err(format!("Invalid HuggingFace repo: {input:?}"));
        }
    }
    Ok(format!("{owner}/{name}"))
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
    let repo = normalize_repo(&repo)?;
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

// ---------------------------------------------------------------------------
// HuggingFace discovery (read-only metadata)
//
// These two commands only ever issue read-only `GET`s to `huggingface.co` and
// return JSON (model ids, file names, sizes). Nothing fetched here is ever
// written to disk or executed — the only artifact AKA writes is a validated
// `.gguf` via `download_model`. The repo is host-pinned through `normalize_repo`
// so a pasted value can never redirect a request off-host.
// ---------------------------------------------------------------------------

const HF_USER_AGENT: &str = concat!("AKA/", env!("CARGO_PKG_VERSION"));

/// A search hit from the HuggingFace model index.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfModel {
    pub id: String,
    pub downloads: u64,
    pub likes: u64,
}

/// A single `.gguf` file inside a repo, with its real (LFS) size.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfGgufFile {
    /// Bare filename, e.g. `model-q4_k_m.gguf`.
    pub filename: String,
    pub size_bytes: u64,
    /// True when this is one shard of a multi-part model (`-00001-of-000NN`).
    /// Such files can't be loaded individually, so the UI disables them.
    pub sharded: bool,
}

fn hf_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(HF_USER_AGENT)
        .build()
        .map_err(|e| format!("client: {e}"))
}

/// Search HuggingFace for GGUF models matching `query`, ranked by downloads.
/// Read-only; returns at most 30 hits.
#[tauri::command]
pub async fn hf_search_models(query: String) -> Result<Vec<HfModel>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // `filter=gguf` restricts to repos tagged GGUF — the only format AKA loads.
    let url = "https://huggingface.co/api/models";
    let client = hf_client()?;
    let resp = client
        .get(url)
        .query(&[
            ("search", q),
            ("filter", "gguf"),
            ("sort", "downloads"),
            ("direction", "-1"),
            ("limit", "30"),
        ])
        .send()
        .await
        .map_err(|e| format!("search request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HuggingFace search failed: HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct Raw {
        id: String,
        #[serde(default)]
        downloads: u64,
        #[serde(default)]
        likes: u64,
    }
    let raw: Vec<Raw> = resp
        .json()
        .await
        .map_err(|e| format!("parse search results: {e}"))?;
    Ok(raw
        .into_iter()
        .map(|r| HfModel {
            id: r.id,
            downloads: r.downloads,
            likes: r.likes,
        })
        .collect())
}

/// List the `.gguf` files in a HuggingFace repo with their real sizes.
/// Accepts an `owner/name` id or a pasted huggingface.co URL.
#[tauri::command]
pub async fn hf_list_gguf_files(repo: String) -> Result<Vec<HfGgufFile>, String> {
    let repo = normalize_repo(&repo)?;
    // The tree API reports the LFS pointer's real size under `lfs.size`; the
    // top-level `size` is just the pointer file for LFS-tracked weights.
    let url = format!("https://huggingface.co/api/models/{repo}/tree/main?recursive=true");
    let client = hf_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("file-list request: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Repository not found: {repo}"));
    }
    if !resp.status().is_success() {
        return Err(format!("Could not list files: HTTP {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct Lfs {
        size: u64,
    }
    #[derive(serde::Deserialize)]
    struct Entry {
        #[serde(rename = "type")]
        kind: String,
        path: String,
        #[serde(default)]
        size: u64,
        #[serde(default)]
        lfs: Option<Lfs>,
    }
    let entries: Vec<Entry> = resp
        .json()
        .await
        .map_err(|e| format!("parse file list: {e}"))?;

    let mut out: Vec<HfGgufFile> = entries
        .into_iter()
        .filter(|e| e.kind == "file" && e.path.to_ascii_lowercase().ends_with(".gguf"))
        .filter_map(|e| {
            // Keep only top-level files (a bare filename) — nested paths can't be
            // addressed by the `safe_filename`-gated download command anyway.
            let filename = e.path.rsplit('/').next().unwrap_or(&e.path).to_string();
            if filename != e.path {
                return None;
            }
            let size_bytes = e.lfs.map(|l| l.size).unwrap_or(e.size);
            let sharded = is_sharded(&filename);
            Some(HfGgufFile {
                filename,
                size_bytes,
                sharded,
            })
        })
        .collect();
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(out)
}

/// Detect a multi-part GGUF shard name like `model-00001-of-00002.gguf`.
fn is_sharded(filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    lower.contains("-of-")
        && lower
            .split("-of-")
            .next()
            .and_then(|p| p.rsplit('-').next())
            .map(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{is_sharded, normalize_repo, safe_filename};

    #[test]
    fn normalizes_bare_and_url_repos() {
        assert_eq!(normalize_repo("Qwen/Qwen2.5-Coder-7B").unwrap(), "Qwen/Qwen2.5-Coder-7B");
        assert_eq!(
            normalize_repo("https://huggingface.co/TheBloke/Llama-3-8B-GGUF").unwrap(),
            "TheBloke/Llama-3-8B-GGUF"
        );
        assert_eq!(
            normalize_repo("huggingface.co/owner/name/tree/main").unwrap(),
            "owner/name"
        );
        assert_eq!(
            normalize_repo("https://huggingface.co/owner/name/resolve/main/model.gguf").unwrap(),
            "owner/name"
        );
    }

    #[test]
    fn rejects_off_host_and_traversal_repos() {
        assert!(normalize_repo("https://evil.com/owner/name").is_err());
        assert!(normalize_repo("evil.com/owner/name").is_err()); // 3 segments
        assert!(normalize_repo("../../etc/passwd").is_err());
        assert!(normalize_repo("owner/..").is_err());
        assert!(normalize_repo("just-owner").is_err());
        assert!(normalize_repo("").is_err());
        assert!(normalize_repo("own er/na me").is_err());
    }

    #[test]
    fn detects_sharded_files() {
        assert!(is_sharded("model-00001-of-00002.gguf"));
        assert!(is_sharded("Big-Model-Q4_K_M-00001-of-00009.gguf"));
        assert!(!is_sharded("model-q4_k_m.gguf"));
        assert!(!is_sharded("deepseek-of-something.gguf"));
    }

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
