use crate::error::AppError;

/// Open `url` in the user's default browser via the platform opener
/// (`open` on macOS, `xdg-open` on Linux, `start` on Windows). Used by the
/// browser pane's "Open in browser" button to hand off the URL so the user
/// keeps their real browser, extensions, and DevTools.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), AppError> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::ConfigCorrupted {
            reason: format!("refusing to open non-http(s) url: {url}"),
        });
    }

    #[cfg(target_os = "macos")]
    let (bin, args): (&str, Vec<&str>) = ("open", vec![url.as_str()]);
    #[cfg(target_os = "linux")]
    let (bin, args): (&str, Vec<&str>) = ("xdg-open", vec![url.as_str()]);
    #[cfg(target_os = "windows")]
    let (bin, args): (&str, Vec<&str>) = ("cmd", vec!["/C", "start", "", url.as_str()]);

    tokio::process::Command::new(bin)
        .args(args)
        .spawn()
        .map_err(|e| AppError::ConfigCorrupted {
            reason: format!("failed to launch opener: {e}"),
        })?;
    Ok(())
}
