use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;

/// Tracked watchers, keyed by absolute file path. Each entry owns a tokio
/// task that polls mtime and emits `file://changed` when it moves.
#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<HashMap<String, JoinHandle<()>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePayload {
    path: String,
    contents: String,
    mtime_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirChangedPayload {
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    name: String,
    path: String,
    kind: String, // "dir" | "file"
}

const EVT_CHANGED: &str = "file://changed";
const POLL_INTERVAL_MS: u64 = 800;

// Project-tree watcher. Slightly slower cadence than the single-file watcher
// because each tick walks the whole tree (minus noise dirs) — 900ms keeps the
// Preview pane feeling live without hammering the disk on large projects.
const EVT_PROJECT_CHANGED: &str = "project://changed";
const DIR_POLL_INTERVAL_MS: u64 = 900;

// Common noise that bloats the tree and is almost never useful at this UI tier.
// Hidden unconditionally — the agent's own tools still see them on disk.
fn is_noise(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".DS_Store" | "node_modules" | "target" | "dist" | ".next"
    )
}

fn mtime_ms(path: &PathBuf) -> Option<u128> {
    let meta = std::fs::metadata(path).ok()?;
    let t = meta.modified().ok()?;
    Some(
        t.duration_since(SystemTime::UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<FilePayload, String> {
    let p = PathBuf::from(&path);
    let contents = tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| format!("read {}: {}", path, e))?;
    let mtime = mtime_ms(&p).unwrap_or(0);
    Ok(FilePayload {
        path,
        contents,
        mtime_ms: mtime,
    })
}

/// Guess an image MIME type from a file extension. Falls back to
/// `application/octet-stream` for anything unrecognized.
fn image_mime_from_ext(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("heic") => "image/heic",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Read an image file and return it as an OpenAI-compatible `data:` URL
/// (`data:<mime>;base64,<payload>`). This is what lets vision-capable models
/// receive the actual image bytes via the `image_url` content part. Capped at
/// 10 MiB so a stray huge asset can't balloon the chat payload.
#[tauri::command]
pub async fn read_image_base64(path: String) -> Result<String, String> {
    use base64::Engine;

    let p = PathBuf::from(&path);
    if let Ok(meta) = tokio::fs::metadata(&p).await {
        if meta.len() > 10 * 1024 * 1024 {
            return Err(format!("image too large (>10 MiB): {}", path));
        }
    }
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| format!("read {}: {}", path, e))?;
    let mime = image_mime_from_ext(&p);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<u128, String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    tokio::fs::write(&p, contents.as_bytes())
        .await
        .map_err(|e| format!("write {}: {}", path, e))?;
    Ok(mtime_ms(&p).unwrap_or(0))
}

#[tauri::command]
pub async fn watch_file(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    // Replace any existing watcher on the same path.
    {
        let mut map = state.inner.lock().unwrap();
        if let Some(handle) = map.remove(&path) {
            handle.abort();
        }
    }

    let path_clone = path.clone();
    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        let p = PathBuf::from(&path_clone);
        let mut last = mtime_ms(&p).unwrap_or(0);
        let mut ticker = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
        // Skip the first immediate tick.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let now = mtime_ms(&p).unwrap_or(0);
            if now == 0 || now == last {
                continue;
            }
            last = now;
            // Re-read and emit.
            if let Ok(contents) = tokio::fs::read_to_string(&p).await {
                let _ = app_clone.emit(
                    EVT_CHANGED,
                    FilePayload {
                        path: path_clone.clone(),
                        contents,
                        mtime_ms: now,
                    },
                );
            }
        }
    });

    state.inner.lock().unwrap().insert(path, handle);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_file(
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    if let Some(handle) = state.inner.lock().unwrap().remove(&path) {
        handle.abort();
    }
    Ok(())
}

/// Largest mtime anywhere under `p` (the directory itself and every non-noise
/// descendant). Polling this and watching for it to increase is a cheap,
/// dependency-free "did anything in the project change?" signal that works
/// for every dev-server type — including static servers with no HMR/rebuild
/// step of their own. Boxed future so the recursion type-checks.
fn max_mtime_recursive(
    p: PathBuf,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = u128> + Send>> {
    Box::pin(async move {
        let mut max = mtime_ms(&p).unwrap_or(0);
        let mut rd = match tokio::fs::read_dir(&p).await {
            Ok(rd) => rd,
            Err(_) => return max,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_noise(&name) {
                continue;
            }
            let child = entry.path();
            match entry.file_type().await {
                Ok(ft) if ft.is_dir() => {
                    let m = max_mtime_recursive(child).await;
                    if m > max {
                        max = m;
                    }
                }
                Ok(ft) if ft.is_file() => {
                    if let Some(m) = mtime_ms(&child) {
                        if m > max {
                            max = m;
                        }
                    }
                }
                _ => {}
            }
        }
        max
    })
}

/// Watch an entire project directory for changes and emit `project://changed`
/// whenever anything under it is created/modified (noise dirs like
/// `node_modules`, `.git`, `dist` are skipped so a build artifact churn or a
/// package install doesn't spam reloads). The Preview pane subscribes to this
/// so the rendered app refreshes on its own after the user — or an agent —
/// edits files, with no manual reload click.
///
/// Keyed under a `dir:` prefix in the shared `WatcherState` map so it never
/// collides with a single-file watcher on the same path. Re-watching the same
/// directory replaces the previous watcher.
#[tauri::command]
pub async fn watch_dir(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let key = format!("dir:{}", path);
    {
        let mut map = state.inner.lock().unwrap();
        if let Some(handle) = map.remove(&key) {
            handle.abort();
        }
    }

    let path_clone = path.clone();
    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        let root = PathBuf::from(&path_clone);
        let mut last = max_mtime_recursive(root.clone()).await;
        let mut ticker = tokio::time::interval(Duration::from_millis(DIR_POLL_INTERVAL_MS));
        // Skip the first immediate tick.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let now = max_mtime_recursive(root.clone()).await;
            if now > last {
                last = now;
                let _ = app_clone.emit(
                    EVT_PROJECT_CHANGED,
                    DirChangedPayload {
                        path: path_clone.clone(),
                    },
                );
            }
        }
    });

    state.inner.lock().unwrap().insert(key, handle);
    Ok(())
}

#[tauri::command]
pub async fn unwatch_dir(
    state: State<'_, WatcherState>,
    path: String,
) -> Result<(), String> {
    let key = format!("dir:{}", path);
    if let Some(handle) = state.inner.lock().unwrap().remove(&key) {
        handle.abort();
    }
    Ok(())
}

/// Count `\n` bytes in a single file. Returns 0 for unreadable files or files
/// larger than 10 MiB (binary assets, lock files, etc.).
async fn count_file_lines_inner(p: &std::path::Path) -> u64 {
    if let Ok(meta) = tokio::fs::metadata(p).await {
        if meta.len() > 10 * 1024 * 1024 {
            return 0;
        }
    }
    match tokio::fs::read(p).await {
        Ok(bytes) => bytes.iter().filter(|&&b| b == b'\n').count() as u64,
        Err(_) => 0,
    }
}

/// Recursively sum line counts for all files under `p`, skipping noise dirs.
/// Uses a boxed future to allow recursive async calls.
fn count_dir_lines_recursive(
    p: PathBuf,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = u64> + Send>> {
    Box::pin(async move {
        let mut rd = match tokio::fs::read_dir(&p).await {
            Ok(rd) => rd,
            Err(_) => return 0,
        };
        let mut total = 0u64;
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_noise(&name) {
                continue;
            }
            let child = entry.path();
            match entry.file_type().await {
                Ok(ft) if ft.is_dir() => {
                    total += count_dir_lines_recursive(child).await;
                }
                Ok(ft) if ft.is_file() => {
                    total += count_file_lines_inner(&child).await;
                }
                _ => {}
            }
        }
        total
    })
}

/// Count lines in a file or recursively in a directory.
#[tauri::command]
pub async fn count_lines(path: String) -> Result<u64, String> {
    let p = PathBuf::from(&path);
    let meta = tokio::fs::metadata(&p)
        .await
        .map_err(|e| format!("stat {}: {}", path, e))?;
    let count = if meta.is_dir() {
        count_dir_lines_recursive(p).await
    } else {
        count_file_lines_inner(&p).await
    };
    Ok(count)
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntryDto>, String> {
    let p = PathBuf::from(&path);
    let mut rd = tokio::fs::read_dir(&p)
        .await
        .map_err(|e| format!("read_dir {}: {}", path, e))?;
    let mut entries: Vec<DirEntryDto> = Vec::new();
    while let Some(entry) = rd
        .next_entry()
        .await
        .map_err(|e| format!("read_dir entry {}: {}", path, e))?
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_noise(&name) {
            continue;
        }
        let ft = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let kind = if ft.is_dir() { "dir" } else { "file" }.to_string();
        let full = entry.path().to_string_lossy().to_string();
        entries.push(DirEntryDto {
            name,
            path: full,
            kind,
        });
    }
    entries.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

