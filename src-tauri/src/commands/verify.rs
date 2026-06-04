use std::io;
use std::path::Path;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::commands::project_config::load_from_disk;
use crate::error::AppError;
use crate::sandbox::{assert_within_sandbox, SandboxState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinePayload {
    line: String,
    stream: &'static str,
}

const EVT_OUTPUT: &str = "verify://output";

/// Run the project's verify command and stream each stdout/stderr line as a
/// `verify://output` event. Returns the exit code. The command is read from
/// the project config file fresh — never cached between runs.
#[tauri::command]
pub async fn run_verify(
    app: AppHandle,
    sandbox: State<'_, SandboxState>,
    project_path: String,
) -> Result<i32, AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::sandbox(project_path.clone()));
    }

    let sb = sandbox
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    assert_within_sandbox(Path::new(&project_path), &sb)?;

    let cfg = load_from_disk(&project_path).await?;
    let trimmed = cfg.agent.verify_cmd.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::VerifyCommandNotFound { cmd: trimmed });
    }

    let mut parts = trimmed.split_whitespace();
    let bin = parts
        .next()
        .ok_or_else(|| AppError::VerifyCommandNotFound { cmd: trimmed.clone() })?
        .to_string();
    let args: Vec<String> = parts.map(|s| s.to_string()).collect();

    let mut cmd = Command::new(&bin);
    cmd.args(&args);
    cmd.current_dir(&project_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            AppError::VerifyCommandNotFound { cmd: trimmed.clone() }
        } else {
            // Any other spawn failure (permission denied, etc.) still maps to
            // the same actionable banner — the UI just shows the full verify_cmd
            // so the user can adjust .äkä/config.json.
            AppError::VerifyCommandNotFound {
                cmd: format!("{trimmed} ({e})"),
            }
        }
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_out = app.clone();
    let out_task = tokio::spawn(async move {
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
    let err_task = tokio::spawn(async move {
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

    let status = child.wait().await.map_err(|e| AppError::VerifyCommandNotFound {
        cmd: format!("{trimmed} (wait: {e})"),
    })?;
    let _ = out_task.await;
    let _ = err_task.await;

    Ok(status.code().unwrap_or(-1))
}
