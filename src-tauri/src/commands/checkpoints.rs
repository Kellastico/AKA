//! Git-backed working-tree checkpoints for agent runs.
//!
//! AKA snapshots the project's working tree at meaningful points in a run
//! (before the run, after each agent edit, after the run, or on demand) so the
//! user can roll back anything the agent did — even for non-interactive agents
//! that never prompt. This is AKA's agent-agnostic substitute for a proactive
//! "approve every action" gate: we cannot assume an agent exposes hooks to
//! intercept its intentions, but we *can* snapshot state and let the user undo.
//!
//! ## Why this never pollutes the user's repo
//!
//! A checkpoint is a real git commit object, but it is parked under a private
//! ref namespace — `refs/aka/checkpoints/<run_id>/<seq>` — that is invisible to
//! `git log`, `git status`, `git branch`, and `git stash`. We build the tree
//! through a *shadow index* (`GIT_INDEX_FILE` pointed at a throwaway file) so
//! the user's real index/staging area is never touched, and we never move HEAD
//! or any branch. Parking the commit under a ref also keeps it alive against
//! `git gc` until we explicitly delete the ref (see `clear_checkpoints`).
//!
//! All git work goes through `tokio::process::Command` (async, never blocks the
//! main thread) using the same `git -C <path>` pattern as `commands::diff`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::sandbox::{assert_within_sandbox, SandboxState};

/// Emitted whenever a checkpoint is recorded, so the UI timeline updates live.
const EVT_CHECKPOINT: &str = "checkpoint://created";

/// A single working-tree snapshot for a run. The snapshot is a git commit
/// object reachable via `refs/aka/checkpoints/<run_id>/<seq>`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub run_id: String,
    /// Monotonic per-run index; also the trailing component of the ref name.
    pub seq: u64,
    /// The commit sha to restore from.
    pub sha: String,
    /// Human label shown in the timeline ("Before run", "After edit to …").
    pub label: String,
    /// "prerun" | "step" | "postrun" | "manual" | "prerestore".
    pub kind: String,
    /// Files differing from HEAD at snapshot time (informational only).
    pub files_changed: u32,
    /// Unix epoch millis.
    pub created_at: u64,
}

/// One file's net change across a run, derived from `git diff --numstat`
/// between the run's `prerun` and `postrun` checkpoints. Agent-agnostic: it
/// reflects what actually changed on disk, regardless of which agent ran or
/// what (if anything) it printed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// "modified" for a text change, "binary" when git reports `-`/`-` counts.
    pub status: String,
    pub lines_added: u32,
    pub lines_removed: u32,
}

/// Parse `git diff --numstat` output into [`FileChange`] rows. Pure + total —
/// no IO — so it is directly unit-testable. Handles the three shapes git emits:
///   `12\t3\tsrc/App.jsx`                    (text change)
///   `-\t-\tlogo.png`                        (binary — counts unknown)
///   `1\t0\tlib/{a => b}/x.js` / `a => b`    (rename — resolve to the new path)
fn parse_numstat(out: &str) -> Vec<FileChange> {
    let mut rows = Vec::new();
    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let added_s = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        let removed_s = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        let path_raw = match parts.next() {
            Some(s) => s,
            None => continue,
        };
        let binary = added_s == "-" || removed_s == "-";
        let lines_added = added_s.parse::<u32>().unwrap_or(0);
        let lines_removed = removed_s.parse::<u32>().unwrap_or(0);
        let path = resolve_rename_path(path_raw);
        rows.push(FileChange {
            path,
            status: if binary { "binary".into() } else { "modified".into() },
            lines_added,
            lines_removed,
        });
    }
    rows
}

/// Resolve a numstat path that may encode a rename into the post-rename path.
///   `old.txt => new.txt`        → `new.txt`
///   `lib/{a => b}/x.js`         → `lib/b/x.js`
/// A plain path (no ` => `) is returned unchanged.
fn resolve_rename_path(raw: &str) -> String {
    if let (Some(open), Some(arrow)) = (raw.find('{'), raw.find(" => ")) {
        if let Some(close) = raw.find('}') {
            if open < arrow && arrow < close {
                let new_mid = &raw[arrow + 4..close];
                return format!("{}{}{}", &raw[..open], new_mid, &raw[close + 1..]);
            }
        }
    }
    if let Some(idx) = raw.find(" => ") {
        return raw[idx + 4..].to_string();
    }
    raw.to_string()
}

#[derive(Default)]
pub struct CheckpointState {
    /// Recorded checkpoints keyed by run id (== session id). Ordered by
    /// completion; `list_checkpoints` returns them sorted by `seq`.
    runs: Arc<Mutex<HashMap<String, Vec<Checkpoint>>>>,
    /// Next `seq` to hand out per run. Reserved under the lock so concurrent
    /// creates for the same run can never collide on a ref name.
    seqs: Arc<Mutex<HashMap<String, u64>>>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Make a run id safe to embed in a git ref path (no `..`, `~^:?*[`, spaces…).
fn sanitize_ref(run_id: &str) -> String {
    let s: String = run_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if s.is_empty() {
        "run".to_string()
    } else {
        s
    }
}

fn shadow_index_path(run_id: &str, seq: u64) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "aka-ckpt-{}-{}-{}.idx",
        sanitize_ref(run_id),
        seq,
        nanos
    ))
}

/// Run `git -C <project_path> <args…>` with optional extra env, returning
/// trimmed stdout. A non-zero exit becomes an `Err` with the trimmed stderr.
async fn git_env(
    project_path: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(project_path);
    for a in args {
        cmd.arg(a);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn git(project_path: &str, args: &[&str]) -> Result<String, String> {
    git_env(project_path, args, &[]).await
}

async fn is_git_repo(project_path: &str) -> bool {
    git(project_path, &["rev-parse", "--git-dir"]).await.is_ok()
}

async fn head_sha(project_path: &str) -> Option<String> {
    git(project_path, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok()
        .filter(|s| !s.is_empty())
}

/// Snapshot the full working tree (tracked + untracked, respecting
/// `.gitignore`) into a commit parked under `refs/aka/checkpoints/<run>/<seq>`.
/// Returns `(commit_sha, files_changed_vs_head)`. Pure git — no Tauri state —
/// so it is directly unit-testable.
async fn snapshot(
    project_path: &str,
    run_id: &str,
    seq: u64,
    label: &str,
) -> Result<(String, u32), String> {
    let idx = shadow_index_path(run_id, seq);
    let idx_str = idx.to_string_lossy().to_string();
    let idx_env = [("GIT_INDEX_FILE", idx_str.as_str())];

    // Build a tree from the entire working tree via a throwaway index. Starting
    // from an empty index, `add -A` stages every non-ignored file present in the
    // working tree, so `write-tree` yields a tree identical to it. The user's
    // real index is never touched.
    let add_res = git_env(project_path, &["add", "-A"], &idx_env).await;
    let tree_res = match add_res {
        Ok(_) => git_env(project_path, &["write-tree"], &idx_env).await,
        Err(e) => Err(e),
    };
    // Always clean up the temp index, success or failure.
    let _ = tokio::fs::remove_file(&idx).await;
    let tree = tree_res?;

    // Wrap the tree in a commit. Identity is forced so `commit-tree` works
    // regardless of the user's git config, and our snapshots are clearly tagged.
    let head = head_sha(project_path).await;
    let msg = format!("aka checkpoint: {label}");
    let mut args: Vec<String> = vec!["commit-tree".into(), tree.clone()];
    if let Some(h) = &head {
        args.push("-p".into());
        args.push(h.clone());
    }
    args.push("-m".into());
    args.push(msg);
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let commit = git_env(
        project_path,
        &args_ref,
        &[
            ("GIT_AUTHOR_NAME", "AKA"),
            ("GIT_AUTHOR_EMAIL", "aka@localhost"),
            ("GIT_COMMITTER_NAME", "AKA"),
            ("GIT_COMMITTER_EMAIL", "aka@localhost"),
        ],
    )
    .await?;

    // Park the commit under a private ref so gc keeps it and the user never sees it.
    let refname = format!("refs/aka/checkpoints/{}/{}", sanitize_ref(run_id), seq);
    git(project_path, &["update-ref", &refname, &commit]).await?;

    // Count changed files vs HEAD purely for the UI label (best-effort).
    let files_changed = match &head {
        Some(h) => git(project_path, &["diff", "--name-only", h, &commit])
            .await
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
            .unwrap_or(0),
        None => git(project_path, &["ls-tree", "-r", "--name-only", &commit])
            .await
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
            .unwrap_or(0),
    };

    Ok((commit, files_changed))
}

/// Make the working tree exactly match the snapshot `sha` without moving HEAD
/// or any branch. Files modified after the snapshot are reverted, files created
/// after it are removed, and files deleted after it are restored. The index is
/// then reset to HEAD so the restored delta shows as ordinary *unstaged* edits.
async fn restore(project_path: &str, sha: &str) -> Result<(), String> {
    // Point the working tree + index at the snapshot tree. `-u` updates the
    // working tree; `--reset` overwrites local changes and drops tracked files
    // absent from the snapshot.
    git(project_path, &["read-tree", "-u", "--reset", sha]).await?;
    // Remove files created after the snapshot (now untracked). No `-x`, so
    // git-ignored build artifacts (node_modules, target, dist…) survive.
    git(project_path, &["clean", "-fd"]).await?;
    // Reset the index back to HEAD (or empty, in a repo with no commits) so the
    // restored changes read as natural unstaged modifications in `git status`.
    if head_sha(project_path).await.is_some() {
        git(project_path, &["read-tree", "HEAD"]).await?;
    } else {
        git(project_path, &["read-tree", "--empty"]).await?;
    }
    Ok(())
}

/// Reserve the next `seq` for a run, then snapshot, record, and emit. Shared by
/// the `create_checkpoint` command and by `run_agent`'s pre/post-run hooks.
///
/// Returns `Ok(None)` when the project isn't a git repo — checkpoints are a
/// best-effort safety net and must never block a run.
pub async fn create_checkpoint_inner(
    app: &AppHandle,
    state: &CheckpointState,
    project_path: &str,
    run_id: &str,
    label: &str,
    kind: &str,
) -> Result<Option<Checkpoint>, String> {
    if !is_git_repo(project_path).await {
        return Ok(None);
    }

    // Reserve a unique seq up front so two concurrent creates for the same run
    // can never write to the same ref.
    let seq = {
        let mut seqs = state.seqs.lock().await;
        let n = seqs.entry(run_id.to_string()).or_insert(0);
        let cur = *n;
        *n += 1;
        cur
    };

    let (sha, files_changed) = snapshot(project_path, run_id, seq, label).await?;

    let cp = Checkpoint {
        run_id: run_id.to_string(),
        seq,
        sha,
        label: label.to_string(),
        kind: kind.to_string(),
        files_changed,
        created_at: now_millis(),
    };

    {
        let mut runs = state.runs.lock().await;
        runs.entry(run_id.to_string()).or_default().push(cp.clone());
    }
    let _ = app.emit(EVT_CHECKPOINT, &cp);
    Ok(Some(cp))
}

/// True when `project_path` is inside a git work tree — i.e. checkpoints are
/// available. The UI uses this to show "checkpoints unavailable" otherwise.
#[tauri::command]
pub async fn checkpoints_available(project_path: String) -> bool {
    is_git_repo(&project_path).await
}

/// Create an on-demand ("manual") checkpoint, or any caller-specified `kind`.
#[tauri::command]
pub async fn create_checkpoint(
    app: AppHandle,
    state: State<'_, CheckpointState>,
    project_path: String,
    run_id: String,
    label: String,
    kind: Option<String>,
) -> Result<Option<Checkpoint>, String> {
    let kind = kind.unwrap_or_else(|| "manual".to_string());
    create_checkpoint_inner(&app, state.inner(), &project_path, &run_id, &label, &kind).await
}

/// All checkpoints recorded for a run, oldest first.
#[tauri::command]
pub async fn list_checkpoints(
    state: State<'_, CheckpointState>,
    run_id: String,
) -> Result<Vec<Checkpoint>, String> {
    let runs = state.runs.lock().await;
    let mut v = runs.get(&run_id).cloned().unwrap_or_default();
    v.sort_by_key(|c| c.seq);
    Ok(v)
}

/// Net file changes for a run, derived by diffing its `prerun` snapshot against
/// its `postrun` snapshot with `git diff --numstat`. This is AKA's agnostic
/// "what did this agent touch" source — it works for any agent because it reads
/// the disk, not the agent's stdout. Returns an empty list (never an error)
/// when the run has no snapshots yet or the project isn't a git repo, so the
/// caller can treat "no changes" and "unavailable" uniformly.
#[tauri::command]
pub async fn run_file_changes(
    state: State<'_, CheckpointState>,
    project_path: String,
    run_id: String,
) -> Result<Vec<FileChange>, String> {
    let (prerun, postrun) = {
        let runs = state.runs.lock().await;
        let cps = match runs.get(&run_id) {
            Some(v) => v,
            None => return Ok(Vec::new()),
        };
        let prerun = cps.iter().find(|c| c.kind == "prerun").map(|c| c.sha.clone());
        // Last postrun wins if a run somehow recorded more than one.
        let postrun = cps
            .iter()
            .rev()
            .find(|c| c.kind == "postrun")
            .map(|c| c.sha.clone());
        match (prerun, postrun) {
            (Some(a), Some(b)) => (a, b),
            _ => return Ok(Vec::new()),
        }
    };

    match git(&project_path, &["diff", "--numstat", &prerun, &postrun]).await {
        Ok(out) => Ok(parse_numstat(&out)),
        // A diff failure (e.g. an object got gc'd) is non-fatal for the UI.
        Err(_) => Ok(Vec::new()),
    }
}

/// Roll the working tree back to checkpoint `sha`. A `prerestore` checkpoint is
/// taken first so the rollback is itself undoable. Mutates the working tree, so
/// the sandbox is enforced exactly as in `run_agent`.
#[tauri::command]
pub async fn restore_checkpoint(
    app: AppHandle,
    state: State<'_, CheckpointState>,
    sandbox: State<'_, SandboxState>,
    project_path: String,
    run_id: String,
    sha: String,
) -> Result<(), String> {
    let sb = sandbox
        .require()
        .await
        .map_err(|_| "no active project sandbox".to_string())?;
    assert_within_sandbox(Path::new(&project_path), &sb).map_err(|e| e.to_string())?;

    if !is_git_repo(&project_path).await {
        return Err("not a git repository".to_string());
    }

    // Snapshot the current state before clobbering it (best-effort).
    let _ = create_checkpoint_inner(
        &app,
        state.inner(),
        &project_path,
        &run_id,
        "Before restore",
        "prerestore",
    )
    .await;

    restore(&project_path, &sha).await
}

/// Forget a run's checkpoints and delete its private refs (so the objects
/// become gc-able). Called when a session is closed or deleted. Best-effort.
#[tauri::command]
pub async fn clear_checkpoints(
    state: State<'_, CheckpointState>,
    project_path: String,
    run_id: String,
) -> Result<(), String> {
    {
        let mut runs = state.runs.lock().await;
        runs.remove(&run_id);
    }
    {
        let mut seqs = state.seqs.lock().await;
        seqs.remove(&run_id);
    }
    if is_git_repo(&project_path).await {
        let prefix = format!("refs/aka/checkpoints/{}", sanitize_ref(&run_id));
        if let Ok(out) = git(
            &project_path,
            &["for-each-ref", "--format=%(refname)", &prefix],
        )
        .await
        {
            for refname in out.lines().filter(|l| !l.trim().is_empty()) {
                let _ = git(&project_path, &["update-ref", "-d", refname]).await;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as StdCommand;

    #[test]
    fn parse_numstat_handles_text_binary_and_renames() {
        let out = "12\t3\tsrc/App.jsx\n\
                   -\t-\tassets/logo.png\n\
                   1\t0\told.txt => new.txt\n\
                   4\t2\tlib/{a => b}/util.js\n\
                   \n";
        let rows = parse_numstat(out);
        assert_eq!(
            rows,
            vec![
                FileChange { path: "src/App.jsx".into(), status: "modified".into(), lines_added: 12, lines_removed: 3 },
                FileChange { path: "assets/logo.png".into(), status: "binary".into(), lines_added: 0, lines_removed: 0 },
                FileChange { path: "new.txt".into(), status: "modified".into(), lines_added: 1, lines_removed: 0 },
                FileChange { path: "lib/b/util.js".into(), status: "modified".into(), lines_added: 4, lines_removed: 2 },
            ]
        );
    }

    #[test]
    fn parse_numstat_empty_is_empty() {
        assert!(parse_numstat("").is_empty());
        assert!(parse_numstat("\n  \n").is_empty());
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let out = StdCommand::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("aka-ckpt-test-{tag}-{}-{}", std::process::id(), nanos));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[tokio::test]
    async fn snapshot_restores_modified_added_deleted_and_untracked() {
        let dir = temp_dir("roundtrip");
        let pp = dir.to_string_lossy().to_string();

        run_git(&dir, &["init", "-q"]);
        fs::write(dir.join("keep.txt"), "v1\n").unwrap();
        fs::write(dir.join("remove_later.txt"), "bye\n").unwrap();
        run_git(&dir, &["add", "."]);
        run_git(&dir, &["commit", "-q", "-m", "init"]);
        // An untracked (never-added) file present at snapshot time — add -A must
        // capture it so restore can bring it back.
        fs::write(dir.join("untracked_at_snapshot.txt"), "keepme\n").unwrap();

        assert!(is_git_repo(&pp).await);

        let (sha, _files) = snapshot(&pp, "run-test", 0, "baseline").await.unwrap();
        assert!(!sha.is_empty());

        // The private ref exists and resolves to the snapshot commit…
        let parked = git(&pp, &["rev-parse", "refs/aka/checkpoints/run-test/0"])
            .await
            .unwrap();
        assert_eq!(parked, sha);
        // …and is invisible to the user's branch list.
        let branches = git(&pp, &["branch", "--list"]).await.unwrap();
        assert!(!branches.contains("aka"), "checkpoint leaked into branches");

        // Agent mutates the tree: modify, create, delete tracked, delete untracked.
        fs::write(dir.join("keep.txt"), "v2-agent-edit\n").unwrap();
        fs::write(dir.join("new_from_agent.txt"), "created\n").unwrap();
        fs::remove_file(dir.join("remove_later.txt")).unwrap();
        fs::remove_file(dir.join("untracked_at_snapshot.txt")).unwrap();

        restore(&pp, &sha).await.unwrap();

        assert_eq!(fs::read_to_string(dir.join("keep.txt")).unwrap(), "v1\n");
        assert!(dir.join("remove_later.txt").exists(), "tracked delete not restored");
        assert!(
            dir.join("untracked_at_snapshot.txt").exists(),
            "untracked-at-snapshot file not restored"
        );
        assert!(
            !dir.join("new_from_agent.txt").exists(),
            "agent-created file not removed"
        );

        // HEAD/branch never moved — still exactly one commit.
        let count = git(&pp, &["rev-list", "--count", "HEAD"]).await.unwrap();
        assert_eq!(count, "1");

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn non_git_dir_reports_unavailable() {
        let dir = temp_dir("nogit");
        let pp = dir.to_string_lossy().to_string();
        assert!(!is_git_repo(&pp).await);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_works_before_first_commit() {
        // A freshly-init'd repo with no commits must still snapshot (no -p HEAD).
        let dir = temp_dir("nocommit");
        let pp = dir.to_string_lossy().to_string();
        run_git(&dir, &["init", "-q"]);
        fs::write(dir.join("a.txt"), "hi\n").unwrap();

        let (sha, _files) = snapshot(&pp, "run-x", 0, "baseline").await.unwrap();
        assert!(!sha.is_empty());

        fs::write(dir.join("a.txt"), "changed\n").unwrap();
        fs::write(dir.join("b.txt"), "new\n").unwrap();
        restore(&pp, &sha).await.unwrap();

        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "hi\n");
        assert!(!dir.join("b.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
