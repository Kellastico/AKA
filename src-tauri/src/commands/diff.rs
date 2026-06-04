use tokio::process::Command;

/// Run `git diff --no-color HEAD [-- file_path]` inside the project directory
/// and return the raw unified-diff text. Used by the Diff pane to show what
/// the agent has changed since the last commit.
///
/// We invoke git via `-C <project_path>` instead of `current_dir` so the
/// command is a single argv with no working-directory race. `--no-color`
/// strips ANSI escapes so the frontend parser sees plain text.
///
/// Returns an empty string when the working tree matches HEAD — the frontend
/// renders that as a "no changes yet" state.
#[tauri::command]
pub async fn git_diff(
    project_path: String,
    file_path: Option<String>,
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(&project_path)
        .arg("diff")
        .arg("--no-color")
        .arg("HEAD");

    if let Some(fp) = file_path {
        if !fp.trim().is_empty() {
            cmd.arg("--").arg(fp);
        }
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Special-case the common "not a git repo" so the UI can show a clear
        // message instead of a generic failure.
        if stderr.contains("not a git repository") {
            return Err("not a git repository".to_string());
        }
        return Err(format!(
            "git diff exited {}: {}",
            output.status.code().unwrap_or(-1),
            stderr
        ));
    }

    String::from_utf8(output.stdout)
        .map_err(|e| format!("invalid utf-8 in git output: {}", e))
}
