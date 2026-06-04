//! Lifecycle manager for the built-in (managed) runtime sidecar.
//!
//! Owns spawning the `aka-runtime` binary, watching its stdout for the
//! `READY` handshake (with a confirming `/health` probe), crash recovery with
//! a bounded retry budget, and clean shutdown when the app exits. The
//! frontend never touches the process directly — it reads status/port and
//! requests restarts through the Tauri commands at the bottom of this file.
//!
//! Spawning happens entirely Rust-side, so it does not go through the shell
//! plugin's IPC scope (those permissions gate the *frontend* shell API). We
//! only need the plugin registered so `app.shell().sidecar(..)` can resolve
//! the bundled `externalBin`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Frontend events. The runtime list in the UI keys its status dot off these.
const EVT_READY: &str = "runtime:ready";
const EVT_RESTARTING: &str = "runtime:restarting";
const EVT_FAILED: &str = "runtime:failed";
const EVT_UPDATE_AVAILABLE: &str = "runtime:update-available";

/// Where to check for newer sidecar builds. `None` until an update channel
/// exists — the version check then just records the running version and does
/// nothing else. Set this to a JSON endpoint returning `{ "version": "x.y.z" }`
/// to light up update notifications.
const RUNTIME_MANIFEST_URL: Option<&str> = None;

/// First port we try; `find_available_port` scans upward from here.
const PREFERRED_PORT: u16 = 41337;

/// How long to wait for the `READY` line before treating startup as failed.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Crash-recovery budget: more than this many restarts inside
/// `RESTART_WINDOW` and we stop retrying and surface `runtime:failed`.
const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

/// Conservative CUDA layer count used when Windows "Performance Mode" is on.
const CUDA_PERF_LAYERS: u32 = 20;

/// Default context window (tokens) — a good balance for coding workloads.
const DEFAULT_CTX_SIZE: u32 = 8192;

#[derive(Debug, Clone)]
pub enum SidecarStatus {
    Stopped,
    Starting,
    Ready,
    Restarting,
    Error(String),
}

pub struct SidecarState {
    pub child: Option<CommandChild>,
    pub port: u16,
    pub status: SidecarStatus,
    /// Timestamps of recent (auto) restarts, pruned to `RESTART_WINDOW`.
    restart_stamps: Vec<Instant>,
    /// Generation counter. Every spawn and every deliberate kill bumps this.
    /// A watch task only triggers auto-restart if its captured epoch still
    /// matches — otherwise a newer spawn/kill has superseded it and the death
    /// it observed was expected.
    epoch: u64,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            child: None,
            port: 0,
            status: SidecarStatus::Stopped,
            restart_stamps: Vec::new(),
            epoch: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatusDto {
    pub status: String,
    pub port: Option<u16>,
    pub error: Option<String>,
}

impl SidecarStatusDto {
    fn from_state(s: &SidecarState) -> Self {
        let (status, error) = match &s.status {
            SidecarStatus::Stopped => ("stopped", None),
            SidecarStatus::Starting => ("starting", None),
            SidecarStatus::Ready => ("ready", None),
            SidecarStatus::Restarting => ("restarting", None),
            SidecarStatus::Error(e) => ("error", Some(e.clone())),
        };
        let port = if s.port == 0 { None } else { Some(s.port) };
        Self {
            status: status.to_string(),
            port,
            error,
        }
    }
}

/// Scan upward from `preferred` for a port we can bind on loopback.
pub fn find_available_port(preferred: u16) -> u16 {
    for port in preferred..preferred.saturating_add(100) {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    // Extremely unlikely; fall back to the preferred port and let bind fail
    // loudly in the sidecar rather than panicking the host app.
    preferred
}

/// True if we can bind `port` on loopback right now (i.e. it is free).
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Force-kill whatever process is holding `port`. Used only for orphan
/// recovery: when the preferred port is occupied but ÄKÄ has no live child, the
/// occupant is an orphaned sidecar from a previous hard crash. Best-effort —
/// any failure just falls through to `find_available_port` picking another port.
fn kill_port_occupant(port: u16) {
    #[cfg(unix)]
    {
        if let Ok(output) = std::process::Command::new("lsof")
            .args(["-ti", &format!(":{port}")])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.split_whitespace() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // Parse `netstat -ano` for a LISTENING row on this port, then taskkill
        // the owning PID.
        if let Ok(output) = std::process::Command::new("netstat")
            .args(["-ano"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            let needle = format!(":{port}");
            for line in text.lines() {
                if !line.contains(&needle) || !line.contains("LISTENING") {
                    continue;
                }
                if let Some(pid) = line.split_whitespace().last() {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", pid, "/F"])
                        .output();
                }
            }
        }
    }
    std::thread::sleep(Duration::from_millis(300));
}

/// Whether the user enabled Windows "Performance Mode" (opt-in CUDA).
fn cuda_pref_enabled(app: &AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;
    match app.store("settings.json") {
        Ok(store) => store
            .get("performance_mode_cuda")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// GPU layers to launch with. Honours the Windows opt-in CUDA preference;
/// otherwise uses the auto-detected value (Metal = all, Linux CUDA = 20,
/// CPU = 0).
fn effective_gpu_layers(app: &AppHandle, profile: &crate::hardware::HardwareProfile) -> u32 {
    if cfg!(target_os = "windows") && profile.gpu_layers == 0 && cuda_pref_enabled(app) {
        CUDA_PERF_LAYERS
    } else {
        profile.gpu_layers
    }
}

async fn health_ok(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
struct HealthInfo {
    version: String,
}

#[derive(Debug, Deserialize)]
struct RuntimeManifest {
    version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePayload {
    current: String,
    latest: String,
}

/// Numeric "a > b" comparison for dotted versions (e.g. "0.2.0" > "0.1.0").
fn version_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> { s.split('.').filter_map(|x| x.parse().ok()).collect() };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// After the runtime is ready, record its version and (if an update channel is
/// configured) check the manifest. Detect-and-notify only — never auto-updates.
async fn check_runtime_version(app: &AppHandle, port: u16) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let Ok(resp) = client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
    else {
        return;
    };
    let Ok(info) = resp.json::<HealthInfo>().await else {
        return;
    };

    // Persist the running runtime version for diagnostics / future updates.
    {
        use tauri_plugin_store::StoreExt;
        if let Ok(store) = app.store("settings.json") {
            store.set("runtime_version", serde_json::json!(info.version));
            let _ = store.save();
        }
    }

    let Some(url) = RUNTIME_MANIFEST_URL else {
        return; // no update channel configured yet
    };
    let Ok(mresp) = client.get(url).send().await else {
        return;
    };
    let Ok(manifest) = mresp.json::<RuntimeManifest>().await else {
        return;
    };
    if version_gt(&manifest.version, &info.version) {
        let _ = app.emit(
            EVT_UPDATE_AVAILABLE,
            UpdatePayload {
                current: info.version,
                latest: manifest.version,
            },
        );
    }
}

fn set_status(app: &AppHandle, status: SidecarStatus) {
    let state = app.state::<Mutex<SidecarState>>();
    let mut s = state.lock().unwrap();
    s.status = status;
}

/// Spawn the sidecar and begin watching it. Bumps the generation epoch so any
/// previously-running watch task knows it has been superseded.
pub async fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    // If the preferred port is occupied but we have no live child, the
    // occupant is an orphaned sidecar from a previous crash (clean shutdown
    // always kills our child). Reclaim the port so we can bind it again rather
    // than drifting upward and leaving the orphan running.
    if !port_is_free(PREFERRED_PORT) {
        let no_child = {
            let state = app.state::<Mutex<SidecarState>>();
            let s = state.lock().unwrap();
            s.child.is_none()
        };
        if no_child {
            tracing::warn!(
                "port {PREFERRED_PORT} occupied with no live child — killing orphaned runtime"
            );
            kill_port_occupant(PREFERRED_PORT);
        }
    }

    let port = find_available_port(PREFERRED_PORT);
    let dir = crate::commands::models::models_dir(app);
    let _ = std::fs::create_dir_all(&dir);

    let profile = crate::hardware::detect();
    let gpu_layers = effective_gpu_layers(app, &profile);
    let threads = profile.recommended_threads;

    let (rx, child) = app
        .shell()
        .sidecar("aka-runtime")
        .map_err(|e| e.to_string())?
        .args([
            "--port",
            &port.to_string(),
            "--models-dir",
            &dir.to_string_lossy(),
            "--gpu-layers",
            &gpu_layers.to_string(),
            "--threads",
            &threads.to_string(),
            "--ctx-size",
            &DEFAULT_CTX_SIZE.to_string(),
        ])
        .spawn()
        .map_err(|e| e.to_string())?;

    let my_epoch = {
        let state = app.state::<Mutex<SidecarState>>();
        let mut s = state.lock().unwrap();
        s.epoch = s.epoch.wrapping_add(1);
        s.child = Some(child);
        s.port = port;
        s.status = SidecarStatus::Starting;
        s.epoch
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        watch_sidecar(app, rx, port, my_epoch).await;
    });
    Ok(())
}

/// Kick off an auto-restart on its own task. The watch task calls this rather
/// than awaiting `restart_sidecar` directly — awaiting would create a
/// `watch → restart → spawn → watch` future cycle that can't satisfy `Send`.
fn trigger_restart(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        restart_sidecar(&app).await;
    });
}

/// True if a newer spawn/kill has superseded the watcher identified by
/// `my_epoch` — i.e. the process death it just saw was expected.
fn superseded(app: &AppHandle, my_epoch: u64) -> bool {
    let state = app.state::<Mutex<SidecarState>>();
    let s = state.lock().unwrap();
    s.epoch != my_epoch
}

async fn watch_sidecar(app: AppHandle, mut rx: Receiver<CommandEvent>, port: u16, my_epoch: u64) {
    let mut ready = false;
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;

    loop {
        // Until READY, enforce the startup deadline; after, wait indefinitely.
        let event = if ready {
            rx.recv().await
        } else {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(ev) => ev,
                Err(_) => {
                    if superseded(&app, my_epoch) {
                        return;
                    }
                    tracing::warn!("aka-runtime: READY not seen within {READY_TIMEOUT:?}");
                    trigger_restart(&app);
                    return;
                }
            }
        };

        let Some(event) = event else {
            // Channel closed — process is gone.
            if !superseded(&app, my_epoch) {
                tracing::warn!("aka-runtime: event channel closed unexpectedly");
                trigger_restart(&app);
            }
            return;
        };

        match event {
            CommandEvent::Stdout(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                if !ready && text.contains("READY") && health_ok(port).await {
                    ready = true;
                    set_status(&app, SidecarStatus::Ready);
                    let _ = app.emit(EVT_READY, port);
                    tracing::info!("aka-runtime ready on port {port}");
                    // Record version + check for runtime updates (best-effort).
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        check_runtime_version(&app2, port).await;
                    });
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim();
                if !line.is_empty() {
                    tracing::warn!(target: "aka-runtime", "{line}");
                }
            }
            CommandEvent::Error(e) => {
                tracing::warn!("aka-runtime stream error: {e}");
            }
            CommandEvent::Terminated(payload) => {
                tracing::warn!("aka-runtime terminated: {payload:?}");
                if !superseded(&app, my_epoch) {
                    trigger_restart(&app);
                }
                return;
            }
            _ => {}
        }
    }
}

/// Auto-restart after an unexpected exit. Enforces the retry budget; gives up
/// (emitting `runtime:failed`) after `MAX_RESTARTS` failures in
/// `RESTART_WINDOW`.
pub async fn restart_sidecar(app: &AppHandle) {
    {
        let state = app.state::<Mutex<SidecarState>>();
        let mut s = state.lock().unwrap();
        let now = Instant::now();
        s.restart_stamps
            .retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        if s.restart_stamps.len() >= MAX_RESTARTS {
            s.status = SidecarStatus::Error("runtime failed to stay running".into());
            drop(s);
            let _ = app.emit(EVT_FAILED, ());
            tracing::error!("aka-runtime: {MAX_RESTARTS} failures within {RESTART_WINDOW:?} — giving up");
            return;
        }
        s.restart_stamps.push(now);
        s.status = SidecarStatus::Restarting;
        if let Some(child) = s.child.take() {
            let _ = child.kill();
        }
    }
    let _ = app.emit(EVT_RESTARTING, ());
    tokio::time::sleep(Duration::from_secs(2)).await;
    if let Err(e) = spawn_sidecar(app).await {
        tracing::error!("aka-runtime respawn failed: {e}");
        set_status(app, SidecarStatus::Error(e));
        let _ = app.emit(EVT_FAILED, ());
    }
}

/// Kill the running sidecar on app exit. Bumps the epoch and sets `Stopped`
/// so the watch task treats the death as expected and does not restart.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<Mutex<SidecarState>>();
    let mut s = state.lock().unwrap();
    s.epoch = s.epoch.wrapping_add(1);
    s.status = SidecarStatus::Stopped;
    if let Some(child) = s.child.take() {
        let _ = child.kill();
    }
}

// ---------- Tauri commands ----------

#[tauri::command]
pub fn get_sidecar_status(state: State<Mutex<SidecarState>>) -> SidecarStatusDto {
    let s = state.lock().unwrap();
    SidecarStatusDto::from_state(&s)
}

/// Resolved port the sidecar is bound to. Frontend reads this dynamically —
/// the port is never hardcoded there.
#[tauri::command]
pub fn get_sidecar_port(state: State<Mutex<SidecarState>>) -> Option<u16> {
    let s = state.lock().unwrap();
    if s.port == 0 {
        None
    } else {
        Some(s.port)
    }
}

/// User-initiated restart. Resets the failure budget (this is a deliberate
/// action, not a crash loop) and brings the sidecar back up.
#[tauri::command]
pub async fn restart_runtime(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<Mutex<SidecarState>>();
        let mut s = state.lock().unwrap();
        s.restart_stamps.clear();
        s.epoch = s.epoch.wrapping_add(1);
        s.status = SidecarStatus::Restarting;
        if let Some(child) = s.child.take() {
            let _ = child.kill();
        }
    }
    let _ = app.emit(EVT_RESTARTING, ());
    tokio::time::sleep(Duration::from_millis(300)).await;
    spawn_sidecar(&app).await
}

/// Immediately cancel any in-progress generation on the built-in runtime by
/// POSTing to its `/abort` endpoint. Called by the frontend whenever the user
/// stops a generation (stop button, new task, mode switch) before issuing the
/// next request, and by the stuck-detection watchdog. No-op (Ok) if the
/// sidecar isn't running.
#[tauri::command]
pub async fn abort_runtime(state: State<'_, Mutex<SidecarState>>) -> Result<bool, String> {
    let port = {
        let s = state.lock().unwrap();
        if s.port == 0 {
            return Ok(false);
        }
        s.port
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    match client
        .post(format!("http://127.0.0.1:{port}/abort"))
        .send()
        .await
    {
        Ok(resp) => Ok(resp.status().is_success()),
        // Sidecar gone/unreachable — nothing to abort, not a hard error.
        Err(_) => Ok(false),
    }
}

/// Explicitly load a model into the built-in runtime ahead of first use, by
/// POSTing to its `/v1/models/load` endpoint. Lets the model browser preload
/// (with a spinner) and surface load failures up front rather than on the first
/// chat request. The long timeout covers large models — loading a 14B can take
/// tens of seconds. Returns the sidecar's error message on failure.
#[tauri::command]
pub async fn load_builtin_model(
    state: State<'_, Mutex<SidecarState>>,
    filename: String,
) -> Result<(), String> {
    let port = {
        let s = state.lock().unwrap();
        if s.port == 0 {
            return Err("Built-in runtime is not running".into());
        }
        s.port
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://127.0.0.1:{port}/v1/models/load"))
        .json(&serde_json::json!({ "filename": filename }))
        .send()
        .await
        .map_err(|e| format!("could not reach built-in runtime: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        // Surface the sidecar's `{ "error": "…" }` body when present.
        let msg = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| "model load failed".to_string());
        Err(msg)
    }
}

/// Unload the built-in runtime's current model, freeing its weights, by POSTing
/// to `/v1/models/unload`. No-op (Ok) if the sidecar isn't running.
#[tauri::command]
pub async fn unload_builtin_model(state: State<'_, Mutex<SidecarState>>) -> Result<(), String> {
    let port = {
        let s = state.lock().unwrap();
        if s.port == 0 {
            return Ok(());
        }
        s.port
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let _ = client
        .post(format!("http://127.0.0.1:{port}/v1/models/unload"))
        .send()
        .await;
    Ok(())
}

/// Windows opt-in "Performance Mode": verify CUDA drivers exist, persist the
/// preference, then restart the sidecar so it launches with GPU offload.
/// Never auto-enabled — surfaced as a toggle in runtime settings.
#[tauri::command]
pub async fn enable_cuda_mode(app: AppHandle) -> Result<(), String> {
    if !crate::hardware::cuda_available() {
        return Err("CUDA drivers not found on this system".into());
    }
    {
        use tauri_plugin_store::StoreExt;
        let store = app.store("settings.json").map_err(|e| e.to_string())?;
        store.set("performance_mode_cuda", serde_json::json!(true));
        let _ = store.save();
    }
    restart_runtime(app).await
}
