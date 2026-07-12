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
/// the sandbox — no hunks are applied in that case. When `run_id` is given
/// (the built-in loop passes its run key), the working tree is snapshotted
/// first — the same checkpoint-before-write contract as `apply_str_replace` —
/// so a mid-run patch is undoable on its own, not only via the run baseline.
#[tauri::command]
pub async fn apply_diff(
    app: AppHandle,
    state: State<'_, SandboxState>,
    checkpoints: State<'_, crate::commands::checkpoints::CheckpointState>,
    patch: String,
    project_path: String,
    run_id: Option<String>,
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

    // Snapshot before the patch lands so it's undoable on its own (best-effort,
    // agnostic) — only when a run owns this edit. A bare editor-driven apply
    // (no run_id) keeps the historical no-checkpoint behaviour.
    if let Some(run_id) = run_id.as_deref().filter(|r| !r.trim().is_empty()) {
        let _ = crate::commands::checkpoints::create_checkpoint_inner(
            &app,
            checkpoints.inner(),
            &project_path,
            run_id,
            "Before patch",
            "step",
        )
        .await;
    }

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

// ---------- apply_str_replace (anchored edit) ----------

/// One anchored string-replace request from a tool. `old_str` is the anchor that
/// must appear **exactly once** in the file; `new_str` replaces it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrReplace {
    /// Project-relative or absolute path to the file to edit.
    pub path: String,
    /// The exact text to find (non-empty, must match exactly once).
    pub old_str: String,
    /// The replacement text.
    pub new_str: String,
}

/// What `apply_str_replace` returns: enough for the UI to refresh and render a
/// before/after diff (Monaco diffs the two contents client-side, so no server-side
/// unified diff is needed). Line counts are best-effort.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub path: String,
    pub mtime_ms: u128,
    pub lines_added: u32,
    pub lines_removed: u32,
}

/// Why an anchored edit was rejected before any write happened. Maps to
/// `AppError` at the command boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditError {
    /// The target path resolved outside the project sandbox.
    OutOfScope,
    /// The target file does not exist / could not be read.
    NoSuchFile,
    /// The anchor was empty — too unsafe to apply (would match everywhere).
    EmptyAnchor,
    /// The anchor was not found in the file.
    AnchorNotFound,
    /// The anchor matched more than once — ambiguous, refuse to guess.
    AnchorAmbiguous(usize),
}

impl EditError {
    /// A precise, user-facing reason string.
    pub fn reason(&self) -> String {
        match self {
            EditError::OutOfScope => "path is outside the project".into(),
            EditError::NoSuchFile => "file not found".into(),
            EditError::EmptyAnchor => "old_str is empty".into(),
            EditError::AnchorNotFound => "old_str not found in file".into(),
            EditError::AnchorAmbiguous(n) => {
                format!("old_str matched {n} times — make it unique")
            }
        }
    }
}

/// Pure core of an anchored edit: enforce **non-empty anchor** and **exactly-once
/// match**, then replace the single occurrence. No IO — directly unit-testable.
/// Returns the updated content plus best-effort `(lines_added, lines_removed)`.
pub fn apply_str_replace_inner(
    content: &str,
    old_str: &str,
    new_str: &str,
) -> Result<(String, u32, u32), EditError> {
    if old_str.is_empty() {
        return Err(EditError::EmptyAnchor);
    }
    match content.matches(old_str).count() {
        0 => return Err(EditError::AnchorNotFound),
        1 => {}
        n => return Err(EditError::AnchorAmbiguous(n)),
    }
    let updated = content.replacen(old_str, new_str, 1);
    let lines_removed = old_str.split('\n').count() as u32;
    let lines_added = new_str.split('\n').count() as u32;
    Ok((updated, lines_added, lines_removed))
}

/// Anchored, scope-checked, checkpoint-before-write file edit. The host-side edit
/// primitive enforced **identically for every agent** (AKA-native or foreign):
///   1. resolve the path inside the active sandbox (else `OutOfScope`),
///   2. read it (else `NoSuchFile`),
///   3. require a non-empty anchor matching **exactly once**,
///   4. snapshot the working tree (`create_checkpoint_inner`, kind `"step"`) so the
///      edit is undoable even for a non-interactive agent,
///   5. write the single replacement.
#[tauri::command]
pub async fn apply_str_replace(
    app: AppHandle,
    state: State<'_, SandboxState>,
    checkpoints: State<'_, crate::commands::checkpoints::CheckpointState>,
    project_path: String,
    run_id: String,
    req: StrReplace,
) -> Result<EditResult, AppError> {
    let sandbox = state
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;

    // The caller-supplied project_path must be the active sandbox root.
    assert_within_sandbox(Path::new(&project_path), &sandbox)?;
    let project_root = resolve_canonical(Path::new(&project_path))
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    if project_root != sandbox.project_path {
        return Err(AppError::sandbox(project_root.display().to_string()));
    }

    // Resolve the target (relative paths are project-root-relative) and scope it.
    let target = if Path::new(&req.path).is_absolute() {
        PathBuf::from(&req.path)
    } else {
        project_root.join(&req.path)
    };
    // Pre-tool gate (mirrors gate_egress): an out-of-folder write is denied AND
    // surfaced as a visible @@aka card — never a silent failure.
    if assert_within_sandbox(&target, &sandbox).is_err() {
        let reason = EditError::OutOfScope.reason();
        crate::commands::agent_runner::emit_aka_card(
            &app,
            &run_id,
            crate::tools::execution_witness::denial_card_line(
                "write",
                "apply_str_replace",
                &format!("{reason}: {}", req.path),
            ),
        );
        return Err(AppError::edit_conflict(reason));
    }

    let content = tokio::fs::read_to_string(&target)
        .await
        .map_err(|_| AppError::edit_conflict(EditError::NoSuchFile.reason()))?;

    let (updated, lines_added, lines_removed) =
        apply_str_replace_inner(&content, &req.old_str, &req.new_str)
            .map_err(|e| AppError::edit_conflict(e.reason()))?;

    // Snapshot before the write so the edit is undoable (best-effort, agnostic).
    let file_label = target
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| req.path.clone());
    let _ = crate::commands::checkpoints::create_checkpoint_inner(
        &app,
        checkpoints.inner(),
        &project_path,
        &run_id,
        &format!("Before edit to {file_label}"),
        "step",
    )
    .await;

    tokio::fs::write(&target, updated.as_bytes())
        .await
        .map_err(|e| AppError::edit_conflict(format!("write failed: {e}")))?;

    // Post-tool witness: record the REAL change (project-relative path + content
    // hash + line range) as a visible @@aka write card. This is the host's own
    // observation of what landed on disk, independent of any agent claim.
    let rel = target
        .strip_prefix(&project_root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| req.path.clone());
    let witness = crate::tools::execution_witness::build_witness(
        &rel,
        &updated,
        lines_added,
        lines_removed,
    );
    crate::commands::agent_runner::emit_aka_card(
        &app,
        &run_id,
        crate::tools::execution_witness::witness_card_line(&witness),
    );

    let mtime_ms = tokio::fs::metadata(&target)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);

    Ok(EditResult {
        path: target.to_string_lossy().into_owned(),
        mtime_ms,
        lines_added,
        lines_removed,
    })
}

// ---------- delete_file (approval-gated deletion) ----------

/// Delete a file — enforced from OUTSIDE the agent. The path must resolve inside
/// the sandbox AND the delete must be explicitly approved (deny-by-default via
/// `policy::check(Action::Delete)`). An out-of-folder or unapproved delete is
/// denied and surfaced as a visible `@@aka` card; nothing is removed. Approved
/// deletes snapshot the tree first (undoable) and emit a witness card.
#[tauri::command]
pub async fn delete_file(
    app: AppHandle,
    state: State<'_, SandboxState>,
    checkpoints: State<'_, crate::commands::checkpoints::CheckpointState>,
    project_path: String,
    run_id: String,
    path: String,
    approved: bool,
) -> Result<(), AppError> {
    use crate::tools::policy::{check, Action, PolicyError};

    let sandbox = state
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    let project_root = resolve_canonical(Path::new(&project_path))
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    let target = if Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        project_root.join(&path)
    };
    let limits = crate::commands::project_config::load_from_disk(&project_path)
        .await
        .map(|c| c.capabilities.limits())
        .unwrap_or_default();

    let deny = |reason: &str| {
        crate::commands::agent_runner::emit_aka_card(
            &app,
            &run_id,
            crate::tools::execution_witness::denial_card_line(
                "write",
                "delete_file",
                &format!("{reason}: {path}"),
            ),
        );
    };

    match check(&Action::Delete(&target), &sandbox, &limits) {
        Err(PolicyError::OutOfScope { .. }) => {
            deny("delete outside the project");
            return Err(AppError::sandbox(target.to_string_lossy().into_owned()));
        }
        // Delete is approval-gated: without approval it is denied.
        Err(PolicyError::RequiresApproval { .. }) if !approved => {
            deny("unapproved delete");
            return Err(AppError::edit_conflict("delete not approved".to_string()));
        }
        Err(PolicyError::RequiresApproval { .. }) | Ok(()) => { /* approved → proceed */ }
        Err(PolicyError::Denied { .. }) => {
            deny("delete denied by policy");
            return Err(AppError::edit_conflict("delete denied".to_string()));
        }
    }

    // Snapshot before removal so the deletion is undoable (best-effort).
    let file_label = target
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let _ = crate::commands::checkpoints::create_checkpoint_inner(
        &app,
        checkpoints.inner(),
        &project_path,
        &run_id,
        &format!("Before delete of {file_label}"),
        "step",
    )
    .await;

    // Count lines for the witness before the file is gone.
    let removed_lines = tokio::fs::read_to_string(&target)
        .await
        .map(|c| c.lines().count() as u32)
        .unwrap_or(0);
    tokio::fs::remove_file(&target)
        .await
        .map_err(|e| AppError::edit_conflict(format!("delete failed: {e}")))?;

    // Witness the deletion — after-content is empty; line range = lines removed.
    let rel = target
        .strip_prefix(&project_root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.clone());
    let witness =
        crate::tools::execution_witness::build_witness(&rel, "", 0, removed_lines);
    crate::commands::agent_runner::emit_aka_card(
        &app,
        &run_id,
        crate::tools::execution_witness::witness_card_line(&witness),
    );
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

    #[test]
    fn str_replace_replaces_exactly_one() {
        let (out, added, removed) =
            apply_str_replace_inner("let x = 1;\nlet y = 2;\n", "let y = 2;", "let y = 3;").unwrap();
        assert_eq!(out, "let x = 1;\nlet y = 3;\n");
        assert_eq!((added, removed), (1, 1));
    }

    #[test]
    fn str_replace_rejects_empty_anchor() {
        assert_eq!(
            apply_str_replace_inner("anything", "", "x"),
            Err(EditError::EmptyAnchor)
        );
    }

    #[test]
    fn str_replace_rejects_missing_anchor() {
        assert_eq!(
            apply_str_replace_inner("hello world", "nope", "x"),
            Err(EditError::AnchorNotFound)
        );
    }

    #[test]
    fn str_replace_rejects_ambiguous_anchor() {
        // "foo" appears three times — refuse to guess which.
        assert_eq!(
            apply_str_replace_inner("foo foo foo", "foo", "bar"),
            Err(EditError::AnchorAmbiguous(3))
        );
    }

    #[test]
    fn str_replace_multiline_counts() {
        let (out, added, removed) =
            apply_str_replace_inner("a\nOLD1\nOLD2\nb\n", "OLD1\nOLD2", "NEW").unwrap();
        assert_eq!(out, "a\nNEW\nb\n");
        assert_eq!((added, removed), (1, 2));
    }
}
