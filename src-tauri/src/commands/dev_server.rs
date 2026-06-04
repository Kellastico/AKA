use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::commands::project_config::load_from_disk;
use crate::error::AppError;
use crate::sandbox::{assert_within_sandbox, SandboxState};

const EVT_OUTPUT: &str = "dev://output";
const EVT_DONE: &str = "dev://done";

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerStatus {
    pub running: bool,
}

/// Tracks the (at most one) running dev-server per app session.
///
/// The actual `Child` is owned by the spawned wait-task; the state only holds
/// a oneshot sender used to signal "please kill yourself". Putting the Child
/// behind a Mutex would deadlock `stop_dev_server` — the wait task holds the
/// lock for the entire `child.wait().await`, which never returns for a
/// long-running dev server until something kills it, which can't happen
/// because the killer needs the lock. Channels sidestep that completely.
#[derive(Default)]
pub struct DevServerState {
    kill_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

/// Spawn the project's configured dev-server command. The command must be set
/// via project config first; an empty `cmd` returns ConfigCorrupted so the UI
/// can fall back to its prompt modal. Multiple starts replace the previous
/// child (the old one is killed). Output streams as `dev://output` events;
/// `dev://done` fires when the child exits for any reason.
#[tauri::command]
pub async fn start_dev_server(
    app: AppHandle,
    state: State<'_, DevServerState>,
    sandbox: State<'_, SandboxState>,
    project_path: String,
) -> Result<(), AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::sandbox(project_path.clone()));
    }
    let sb = sandbox
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    assert_within_sandbox(Path::new(&project_path), &sb)?;

    let cfg = load_from_disk(&project_path).await?;
    let dev = cfg.dev_server;
    if dev.cmd.trim().is_empty() {
        return Err(AppError::config_corrupted(
            "dev_server.cmd is not configured for this project",
        ));
    }

    // Signal any previous dev server to die so a re-start is well-defined.
    {
        let mut guard = state.kill_tx.lock().await;
        if let Some(prev_tx) = guard.take() {
            let _ = prev_tx.send(());
        }
    }

    let mut cmd = Command::new(&dev.cmd);
    cmd.args(&dev.args);
    cmd.current_dir(&project_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    // Force-flush Python output. When stdout/stderr are piped (as they are
    // here), CPython switches to block-buffering and a long-running server
    // like http.server never fills its 4KB buffer — so "Serving HTTP on..."
    // never reaches us and the Preview pane hangs on "Waiting for URL...".
    // PYTHONUNBUFFERED=1 is equivalent to passing `-u` and only affects
    // Python; other runtimes ignore it.
    cmd.env("PYTHONUNBUFFERED", "1");

    let mut child = cmd.spawn().map_err(|e| AppError::config_corrupted(format!(
        "failed to spawn dev_server '{}': {}",
        dev.cmd, e
    )))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Register a fresh kill channel. The receiver moves into the wait task
    // below; the sender stays in state so stop_dev_server can fire it.
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let state_kill = state.kill_tx.clone();
    {
        let mut guard = state.kill_tx.lock().await;
        *guard = Some(kill_tx);
    }

    let app_out = app.clone();
    tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_out.emit(
                    EVT_OUTPUT,
                    LinePayload { line, stream: "stdout" },
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
                    LinePayload { line, stream: "stderr" },
                );
            }
        }
    });

    // The wait task OWNS the Child (no shared lock). It races the natural
    // child.wait() against the kill channel — whichever fires first wins.
    // When kill fires we send SIGKILL and then keep waiting for the real
    // exit status so we still emit dev://done with an accurate code.
    let app_done = app.clone();
    tokio::spawn(async move {
        let exit_code = tokio::select! {
            status = child.wait() => status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1),
            _ = kill_rx => {
                let _ = child.start_kill();
                child.wait().await.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)
            }
        };
        // Clear the kill sender slot so subsequent stop calls report "no
        // running server" instead of erroring on a closed channel.
        {
            let mut guard = state_kill.lock().await;
            *guard = None;
        }
        let _ = app_done.emit(EVT_DONE, DonePayload { exit_code });
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_dev_server(state: State<'_, DevServerState>) -> Result<bool, String> {
    // Take the sender out and fire it. The wait task picks up the signal,
    // kills the child, and emits dev://done — no lock contention with wait.
    let tx = {
        let mut guard = state.kill_tx.lock().await;
        guard.take()
    };
    if let Some(tx) = tx {
        let _ = tx.send(());
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn dev_server_status(state: State<'_, DevServerState>) -> Result<DevServerStatus, ()> {
    let guard = state.kill_tx.lock().await;
    Ok(DevServerStatus { running: guard.is_some() })
}

/// Force-kill every process listening on `port`. Returns the number of PIDs
/// killed (0 if the port was already free). Used by the Preview pane's
/// "Kill port & restart" button when the dev server fails to start because
/// something else still owns the address. The user typed the URL themselves,
/// so we don't second-guess the port choice — but we do refuse port 0 and
/// out-of-range values to avoid weird shell behavior.
#[tauri::command]
pub async fn kill_port(port: u16) -> Result<u32, String> {
    if port == 0 {
        return Err("port 0 is not a valid target".into());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        // `lsof -ti :PORT` prints one PID per line. Exit code 1 with empty
        // output just means "nothing listening" — treat that as success.
        let out = Command::new("lsof")
            .arg("-ti")
            .arg(format!(":{port}"))
            .output()
            .await
            .map_err(|e| format!("failed to run lsof: {e}"))?;

        let pids: Vec<i32> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|s| s.trim().parse::<i32>().ok())
            .collect();

        let mut killed = 0u32;
        for pid in pids {
            let status = Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status()
                .await
                .map_err(|e| format!("failed to spawn kill: {e}"))?;
            if status.success() {
                killed += 1;
            }
        }
        Ok(killed)
    }

    #[cfg(target_os = "windows")]
    {
        // PowerShell one-liner: list listeners on the port, force-stop their
        // owning processes, count successes. -ErrorAction SilentlyContinue
        // keeps "nothing listening" from being treated as a hard failure.
        let script = format!(
            "$c = Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction SilentlyContinue; \
             if (-not $c) {{ Write-Output 0; exit 0 }}; \
             $n = 0; \
             foreach ($p in ($c | Select-Object -ExpandProperty OwningProcess -Unique)) {{ \
                 try {{ Stop-Process -Id $p -Force -ErrorAction Stop; $n++ }} catch {{}} \
             }}; Write-Output $n"
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .await
            .map_err(|e| format!("failed to run powershell: {e}"))?;
        let killed: u32 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0);
        Ok(killed)
    }
}
