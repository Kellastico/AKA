use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::sandbox::{assert_within_sandbox, SandboxState};

const EVT_OUTPUT: &str = "shell://output";
const EVT_DONE: &str = "shell://done";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinePayload {
    line: String,
    stream: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    exit_code: i32,
}

/// At most one ad-hoc shell command in flight at a time. Re-invoking
/// `shell_run` kills the previous child first so the UI can never "lose"
/// a process behind a new one.
#[derive(Default)]
pub struct ShellRunnerState {
    child: Arc<Mutex<Option<Child>>>,
}

/// Run a free-form shell line inside the project sandbox via `sh -c "<cmd>"`.
/// Going through `sh` (not `Command::new(cmd).args(args)`) means pipes, `&&`,
/// env-var expansion, glob patterns, and quoting all work the way the user
/// expects from a real terminal — which is the point of the Console pane.
///
/// Streams stdout/stderr as `shell://output` events and emits `shell://done`
/// with the exit code when the child terminates. Returns immediately after
/// spawn so long-running commands (dev servers, watchers) don't block the
/// IPC handler.
#[tauri::command]
pub async fn shell_run(
    app: AppHandle,
    state: State<'_, ShellRunnerState>,
    sandbox: State<'_, SandboxState>,
    project_path: String,
    cmd: String,
) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Err("no active project".into());
    }
    let cmd_trim = cmd.trim().to_string();
    if cmd_trim.is_empty() {
        return Err("empty command".into());
    }

    let sb = sandbox
        .require()
        .await
        .map_err(|_| "no sandbox set for project".to_string())?;
    assert_within_sandbox(Path::new(&project_path), &sb).map_err(|e| e.to_string())?;

    // Kill the previous run before spawning a new one — same invariant as
    // dev_server. The console enforces "one command at a time" in the UI too.
    {
        let mut guard = state.child.lock().await;
        if let Some(prev) = guard.as_mut() {
            let _ = prev.start_kill();
        }
        *guard = None;
    }

    let mut command = Command::new("sh");
    command.arg("-c").arg(&cmd_trim);
    command.current_dir(&project_path);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
    // Force-flush Python output when the user runs `python3 something.py` or
    // similar from the Console — same buffering trap as the dev server.
    // Harmless for non-Python commands.
    command.env("PYTHONUNBUFFERED", "1");

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn shell: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child_handle = state.child.clone();

    {
        let mut guard = state.child.lock().await;
        *guard = Some(child);
    }

    let app_out = app.clone();
    tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_out.emit(
                    EVT_OUTPUT,
                    LinePayload {
                        line,
                        stream: "stdout",
                    },
                );
            }
        }
    });

    let app_err = app.clone();
    tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_err.emit(
                    EVT_OUTPUT,
                    LinePayload {
                        line,
                        stream: "stderr",
                    },
                );
            }
        }
    });

    // Reap on a detached task so the IPC call returns now and the UI flips
    // into the "running" state immediately rather than waiting for exit.
    let app_done = app.clone();
    tokio::spawn(async move {
        let exit_code = {
            let mut guard = child_handle.lock().await;
            match guard.as_mut() {
                Some(c) => c
                    .wait()
                    .await
                    .map(|s| s.code().unwrap_or(-1))
                    .unwrap_or(-1),
                None => return,
            }
        };
        {
            let mut guard = child_handle.lock().await;
            *guard = None;
        }
        let _ = app_done.emit(EVT_DONE, DonePayload { exit_code });
    });

    Ok(())
}

#[tauri::command]
pub async fn shell_stop(state: State<'_, ShellRunnerState>) -> Result<bool, String> {
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.as_mut() {
        let _ = child.start_kill();
        Ok(true)
    } else {
        Ok(false)
    }
}
