//! ÄKÄ Built-in Runtime — sidecar inference server.
//!
//! A self-contained OpenAI-compatible HTTP server that ÄKÄ bundles and owns
//! the lifecycle of. The parent app spawns this binary, watches stdout for
//! the `READY port=<port>` line, then talks to it exactly like any other
//! OpenAI-compatible runtime (Ollama, LM Studio, …).
//!
//! Inference runs on real llama.cpp via the `llama-cpp-2` bindings (see
//! `inference.rs`). Models are loaded lazily on the first chat request (or
//! explicitly via `POST /v1/models/load`) and generation streams token-by-token
//! over SSE, interruptible through the per-request abort path.

mod hardware;
mod inference;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use clap::Parser;
use llama_cpp_2::llama_backend::LlamaBackend;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use tokio::net::TcpListener;

use inference::LoadedModel;

const VERSION: &str = "0.1.0";
/// Reported in `/health` — the llama.cpp bindings build this runtime links
/// against. Real inference, so never `"stub"`.
const LLAMA_CPP_BUILD: &str = "llama-cpp-2/0.1.146";

#[derive(Parser, Debug)]
#[command(name = "aka-runtime", version = VERSION)]
struct Args {
    /// Port to bind the HTTP server on (127.0.0.1 only).
    #[arg(long)]
    port: u16,

    /// Directory holding `.gguf` model files.
    #[arg(long)]
    models_dir: PathBuf,

    /// GPU layers to offload. 0 = CPU only. Defaults to auto (0 here; the
    /// launching app normally computes and passes this).
    #[arg(long, default_value_t = 0)]
    gpu_layers: u32,

    /// Inference threads. Defaults to auto-detect (logical cores − 2, min 2).
    #[arg(long)]
    threads: Option<u32>,

    /// Context window size (tokens) to pre-allocate. 8192 is a good default
    /// for coding workloads. No-op with the stub generator; honoured once
    /// real inference is wired.
    #[arg(long, default_value_t = 8192)]
    ctx_size: u32,
}

struct AppState {
    models_dir: PathBuf,
    gpu_layers: u32,
    threads: u32,
    /// Context window (tokens) to allocate per request. Flows from `--ctx-size`
    /// into each request's `LlamaContextParams`.
    ctx_size: u32,
    /// Per-request cancel flags, keyed by a request ID assigned in
    /// `chat_completions`. `POST /abort` flips every registered flag; each
    /// generation loop checks only its own, so a concurrent request can no
    /// longer un-cancel a pending abort by resetting a shared flag.
    active_requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// The llama.cpp backend singleton. Initialised once at startup and kept
    /// alive for the whole process (dropping it before shutdown is UB). Shared
    /// into blocking inference tasks via the `Arc`.
    backend: Arc<LlamaBackend>,
    /// The currently loaded model, if any. `None` until a model is loaded
    /// (lazily on first chat request, or explicitly via `/v1/models/load`).
    /// Held as `Arc<LoadedModel>` so a request can clone it out and release the
    /// lock before running generation, never holding the guard across the work.
    loaded_model: Arc<Mutex<Option<Arc<LoadedModel>>>>,
    /// Decode throughput of the most recent generation, surfaced via `/metrics`
    /// so the UI can show real tokens/sec. `0.0` until the first generation.
    last_tokens_per_sec: Arc<Mutex<f64>>,
}

/// Removes the PID lockfile when dropped, so the file is cleared on clean
/// exit *and* on a panic (unwind), not only the happy path.
struct PidLockfileGuard(PathBuf);

impl Drop for PidLockfileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Best-effort takeover of a stale lockfile from a previous instance that was
/// hard-killed without cleaning up: read the recorded PID, signal it to die,
/// then claim the file with our own PID. Returns a guard that removes the file
/// on drop. Failures here are non-fatal — if the old process is already gone
/// the signal is a harmless no-op.
fn acquire_pid_lockfile() -> PidLockfileGuard {
    let lockfile_path = std::env::temp_dir().join("aka-runtime.pid");

    if lockfile_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&lockfile_path) {
            if let Ok(old_pid) = contents.trim().parse::<u32>() {
                #[cfg(unix)]
                {
                    let _ = unsafe { libc::kill(old_pid as i32, libc::SIGTERM) };
                }
                #[cfg(windows)]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &old_pid.to_string(), "/F"])
                        .output();
                }
                // Brief wait for the old process to release the port.
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }

    let pid = std::process::id();
    if let Err(e) = std::fs::write(&lockfile_path, pid.to_string()) {
        tracing::warn!("could not write PID lockfile {:?}: {e}", lockfile_path);
    }
    PidLockfileGuard(lockfile_path)
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    // All logs go to stderr — stdout is reserved for the `READY` handshake the
    // parent process parses.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_max_level(tracing::Level::INFO)
        .init();

    let threads = args
        .threads
        .unwrap_or_else(|| (num_cpus::get() as u32).saturating_sub(2).max(2));

    // Initialise the llama.cpp backend exactly once. Must stay alive for the
    // whole process — it lives inside the long-lived `AppState`.
    let backend = Arc::new(
        LlamaBackend::init().expect("Failed to initialise llama backend"),
    );

    let state = Arc::new(AppState {
        models_dir: args.models_dir.clone(),
        gpu_layers: args.gpu_layers,
        threads,
        ctx_size: args.ctx_size,
        active_requests: Arc::new(Mutex::new(HashMap::new())),
        backend,
        loaded_model: Arc::new(Mutex::new(None)),
        last_tokens_per_sec: Arc::new(Mutex::new(0.0)),
    });

    // Create the models directory eagerly so `/v1/models` and downloads have
    // a stable target even on a fresh install.
    if let Err(e) = std::fs::create_dir_all(&args.models_dir) {
        tracing::warn!("could not create models dir {:?}: {e}", args.models_dir);
    }

    // Claim the PID lockfile before binding, killing any orphan from a prior
    // hard crash that still holds the port. Bound to a named local so the
    // guard lives for all of `main()` and removes the file on exit/panic —
    // `let _ =` would drop it immediately.
    let _lockfile_guard = acquire_pid_lockfile();

    let app = Router::new()
        .route("/health", get(health))
        .route("/hardware", get(hardware_handler))
        .route("/metrics", get(metrics_handler))
        .route("/v1/models", get(list_models))
        .route("/v1/models/load", post(load_model_handler))
        .route("/v1/models/unload", post(unload_model_handler))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/abort", post(abort_handler))
        .with_state(state);

    let addr = format!("127.0.0.1:{}", args.port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    // The parent process blocks until it sees this exact line on stdout.
    // Print it only once we are actually bound and about to serve.
    println!("READY port={}", args.port);
    let _ = std::io::stdout().flush();
    tracing::info!(
        "aka-runtime {VERSION} listening on {addr} (gpu_layers={}, threads={}, ctx_size={})",
        args.gpu_layers,
        threads,
        args.ctx_size
    );

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("server error: {e}");
        std::process::exit(1);
    }
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": VERSION,
        "llama_cpp_build": LLAMA_CPP_BUILD,
    }))
}

async fn hardware_handler(State(state): State<Arc<AppState>>) -> Json<hardware::HardwareReport> {
    Json(hardware::report(state.gpu_layers, state.threads))
}

/// ÄKÄ-internal runtime metrics for the Context Window panel: real model
/// footprint, this process's RSS, the allocated context window, and the decode
/// throughput of the last generation. The host queries this (the frontend never
/// talks to the sidecar directly).
async fn metrics_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let (model_loaded, model_filename, model_mb) = {
        let guard = state.loaded_model.lock().unwrap();
        match guard.as_ref() {
            Some(m) => (
                true,
                Some(m.filename.clone()),
                m.size_bytes as f64 / (1024.0 * 1024.0),
            ),
            None => (false, None, 0.0),
        }
    };

    // This process's resident set size — for the built-in runtime, the bulk of
    // it is the loaded model weights.
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    let process_rss_mb = sys
        .process(pid)
        .map(|p| p.memory() as f64 / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    let last_tokens_per_sec = *state.last_tokens_per_sec.lock().unwrap();

    Json(json!({
        "modelLoaded": model_loaded,
        "modelFilename": model_filename,
        "modelMb": model_mb,
        "processRssMb": process_rss_mb,
        "ctxSize": state.ctx_size,
        "lastTokensPerSec": last_tokens_per_sec,
    }))
}

/// Validate that `path` is a real GGUF file by its magic bytes (0–3 == "GGUF")
/// and a plausible minimum size. Guards against junk `.gguf` files that would
/// segfault llama.cpp when it tries to parse them (Step 7).
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

/// OpenAI-compatible model list: every valid `.gguf` file in the models directory.
/// Each entry carries an `active` flag marking the currently loaded model.
async fn list_models(State(state): State<Arc<AppState>>) -> Json<Value> {
    let created = unix_secs();
    let active_filename = state
        .loaded_model
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.filename.clone());

    let mut data = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&state.models_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_gguf = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("gguf"))
                .unwrap_or(false);
            if !is_gguf {
                continue;
            }
            // Silently skip corrupt/incomplete files so a junk `.gguf` never
            // appears as a loadable model.
            if !is_valid_gguf(&path) {
                continue;
            }
            let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                data.push(json!({
                    "id": stem,
                    "object": "model",
                    "created": created,
                    "owned_by": "aka",
                    "filename": filename,
                    "active": active_filename.as_deref() == Some(filename),
                    // Unknown until GGUF metadata is parsed (Step 7 extension).
                    "min_ram_gb": Value::Null,
                }));
            }
        }
    }
    Json(json!({ "object": "list", "data": data }))
}

#[derive(Debug, Deserialize)]
struct LoadModelRequest {
    filename: String,
}

/// Map an OpenAI `model` field to a real `.gguf` filename in the models dir.
/// ÄKÄ sends the file *stem* (no extension) as the model id, but a full
/// filename is also accepted. Returns the on-disk filename, or `None` if no
/// valid GGUF matches.
fn find_model_file(models_dir: &std::path::Path, model_id: &str) -> Option<String> {
    let entries = std::fs::read_dir(models_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_gguf = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false);
        if !is_gguf || !is_valid_gguf(&path) {
            continue;
        }
        let filename = path.file_name().and_then(|s| s.to_str());
        let stem = path.file_stem().and_then(|s| s.to_str());
        if filename == Some(model_id) || stem == Some(model_id) {
            return filename.map(str::to_string);
        }
    }
    None
}

/// Ensure the model named by `filename` (a bare `<name>.gguf`) is the currently
/// loaded model, loading it if necessary. Returns the shared handle, or an
/// `(status, message)` pair on failure. Both `/v1/models/load` and the lazy
/// load inside `chat_completions` go through here. The actual weight load runs
/// on a blocking thread so the async runtime is never stalled.
async fn ensure_model_loaded(
    state: &Arc<AppState>,
    filename: &str,
) -> Result<Arc<LoadedModel>, (axum::http::StatusCode, String)> {
    use axum::http::StatusCode;

    // Fast path: requested model is already loaded.
    {
        let guard = state.loaded_model.lock().unwrap();
        if let Some(loaded) = guard.as_ref() {
            if loaded.filename == filename {
                return Ok(Arc::clone(loaded));
            }
        }
    }

    // Validate the file on disk before doing anything expensive.
    let model_path = state.models_dir.join(filename);
    if !model_path.exists() {
        return Err((StatusCode::NOT_FOUND, "Model file not found".to_string()));
    }
    if !is_valid_gguf(&model_path) {
        return Err((
            StatusCode::BAD_REQUEST,
            "File is not a valid GGUF model".to_string(),
        ));
    }

    // RAM preflight using on-disk size as a conservative proxy (×1.2 headroom).
    // Real GGUF-metadata parsing can replace this later; it must never
    // under-estimate, hence rounding the requirement up.
    let file_size_gb = std::fs::metadata(&model_path)
        .map(|m| m.len() as f32 / 1_073_741_824.0)
        .unwrap_or(0.0);
    let estimated_ram_gb = if file_size_gb > 0.0 {
        Some(file_size_gb * 1.2)
    } else {
        None
    };
    if let Err(e) = preflight_ram_check(estimated_ram_gb) {
        return Err((StatusCode::INSUFFICIENT_STORAGE, e));
    }

    // Load off the async runtime — model load is heavy and synchronous.
    let backend = Arc::clone(&state.backend);
    let gpu_layers = state.gpu_layers;
    let ctx_size = state.ctx_size;
    let fname = filename.to_string();
    let path = model_path.clone();

    let loaded = tokio::task::spawn_blocking(move || {
        inference::load_model(&backend, &path, fname, gpu_layers, ctx_size)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Load task panicked: {e}"),
        )
    })?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let arc = Arc::new(loaded);
    *state.loaded_model.lock().unwrap() = Some(Arc::clone(&arc));
    tracing::info!("loaded model {filename}");
    Ok(arc)
}

/// `POST /v1/models/load` — explicitly load a model into memory ahead of time.
/// ÄKÄ-internal (not part of the OpenAI surface). Chat also lazy-loads, so this
/// is optional, but lets the UI preload and surface load errors up front.
async fn load_model_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoadModelRequest>,
) -> Response {
    match ensure_model_loaded(&state, &req.filename).await {
        Ok(_) => Json(json!({ "loaded": true, "filename": req.filename })).into_response(),
        Err((code, msg)) => (code, Json(json!({ "error": msg }))).into_response(),
    }
}

/// `POST /v1/models/unload` — drop the loaded model, freeing its weights.
/// Dropping the last `Arc<LoadedModel>` runs `LlamaModel`'s `Drop`, which frees
/// the llama.cpp model. A concurrently-running request holding its own `Arc`
/// keeps the weights alive until it finishes, then they are freed.
async fn unload_model_handler(State(state): State<Arc<AppState>>) -> Response {
    let was_loaded = state.loaded_model.lock().unwrap().take().is_some();
    Json(json!({ "unloaded": was_loaded })).into_response()
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    #[serde(default)]
    model: String,
    #[serde(default)]
    messages: Vec<ChatMessage>,
    #[serde(default)]
    stream: bool,
    /// Sampling temperature. Defaults to 0.7 when omitted.
    #[serde(default)]
    temperature: Option<f32>,
    /// Maximum tokens to generate. Defaults to 2048 when omitted.
    #[serde(default)]
    max_tokens: Option<usize>,
}

/// Default sampling temperature when the request omits one.
const DEFAULT_TEMPERATURE: f32 = 0.7;
/// Default generation cap when the request omits `max_tokens`.
const DEFAULT_MAX_TOKENS: usize = 2048;

/// Called before any model is loaded into llama.cpp. Returns `Err` if the
/// system lacks the RAM to safely load the model. `None` means the requirement
/// is unknown (file-imported model) — allow without warning at this layer.
/// Step 7: wire the real `min_ram_gb` from GGUF metadata into the caller.
fn preflight_ram_check(model_min_ram_gb: Option<f32>) -> Result<(), String> {
    let Some(required) = model_min_ram_gb else {
        return Ok(()); // unknown — allow
    };
    let mut sys = sysinfo::System::new_all();
    sys.refresh_memory();
    let total_gb = sys.total_memory() as f32 / 1_073_741_824.0;
    if required > total_gb {
        return Err(format!(
            "Insufficient RAM: model needs {required:.1}GB, system has {total_gb:.1}GB"
        ));
    }
    Ok(())
}

async fn chat_completions(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatRequest>,
) -> Response {
    use axum::http::StatusCode;

    // Register a fresh per-request cancel flag. Each generation checks only
    // its own flag, so a concurrent request can't reset a pending abort.
    let request_id = uuid::Uuid::new_v4().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .active_requests
        .lock()
        .unwrap()
        .insert(request_id.clone(), Arc::clone(&cancel_flag));

    // Helper: deregister this request before an early-return error path.
    let deregister = || {
        state.active_requests.lock().unwrap().remove(&request_id);
    };

    // Resolve which model to serve:
    //  - empty `model`  → use whatever is currently loaded; 503 if none.
    //  - named `model`  → map id/stem → filename and (lazy-)load it; 404 if
    //                     the file isn't present.
    let loaded: Arc<LoadedModel> = if req.model.trim().is_empty() {
        let current = state.loaded_model.lock().unwrap().as_ref().map(Arc::clone);
        match current {
            Some(l) => l,
            None => {
                deregister();
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "error": {
                            "message": "No model is loaded. Load a model first via POST /v1/models/load",
                            "type": "no_model_loaded",
                            "code": 503
                        }
                    })),
                )
                    .into_response();
            }
        }
    } else {
        match find_model_file(&state.models_dir, &req.model) {
            Some(filename) => match ensure_model_loaded(&state, &filename).await {
                Ok(l) => l,
                Err((code, msg)) => {
                    deregister();
                    return (code, Json(json!({ "error": { "message": msg } }))).into_response();
                }
            },
            None => {
                deregister();
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({
                        "error": {
                            "message": format!("Model '{}' not found in models directory", req.model),
                            "type": "model_not_found",
                            "code": 404
                        }
                    })),
                )
                    .into_response();
            }
        }
    };

    let created = unix_secs();
    let id = format!("chatcmpl-{created}");
    let model_label = if req.model.is_empty() {
        "aka-builtin".to_string()
    } else {
        req.model.clone()
    };

    // Format the conversation into the model's prompt (cheap; runs here).
    let messages: Vec<(String, String)> = req
        .messages
        .iter()
        .map(|m| (m.role.clone(), m.content.clone()))
        .collect();
    let prompt = inference::format_prompt(&loaded.model, &messages);

    let gen = inference::GenerateParams {
        prompt,
        temperature: req.temperature.unwrap_or(DEFAULT_TEMPERATURE),
        max_tokens: req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        threads: state.threads,
    };

    let backend = Arc::clone(&state.backend);
    let loaded_for_task = Arc::clone(&loaded);
    let cancel_for_task = Arc::clone(&cancel_flag);
    let tps_slot = Arc::clone(&state.last_tokens_per_sec);

    if req.stream {
        // Bridge the synchronous, blocking generation to an async SSE stream
        // via an mpsc channel: the blocking task sends each chunk's JSON, the
        // stream forwards it as an SSE event. The model lock is never held
        // across this boundary — we hold only the cloned `Arc<LoadedModel>`.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
        let id_owned = id.clone();
        let model_owned = model_label.clone();

        tokio::task::spawn_blocking(move || {
            let tx_tok = tx.clone();
            let on_token = |piece: String| -> bool {
                let chunk = json!({
                    "id": &id_owned,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": &model_owned,
                    "choices": [{
                        "index": 0,
                        "delta": { "content": piece },
                        "finish_reason": Value::Null,
                    }],
                });
                // Err means the receiver (client) is gone — stop generating.
                tx_tok.blocking_send(chunk.to_string()).is_ok()
            };

            match inference::generate_blocking(&backend, &loaded_for_task, gen, cancel_for_task, on_token) {
                Ok(tps) => *tps_slot.lock().unwrap() = tps,
                Err(e) => tracing::error!("inference error: {e}"),
            }

            // Closing `stop` chunk + `[DONE]` so the client closes cleanly,
            // matching the OpenAI streaming contract (same shape as the stub).
            let done = json!({
                "id": &id_owned,
                "object": "chat.completion.chunk",
                "created": created,
                "model": &model_owned,
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            });
            let _ = tx.blocking_send(done.to_string());
            let _ = tx.blocking_send("[DONE]".to_string());
        });

        // Forward channel → SSE, deregistering the request once drained
        // (covers normal completion, EOG, abort, and client disconnect).
        let state_for_stream = state.clone();
        let req_id = request_id.clone();
        let stream = async_stream::stream! {
            while let Some(data) = rx.recv().await {
                yield Ok::<Event, std::convert::Infallible>(Event::default().data(data));
            }
            state_for_stream.active_requests.lock().unwrap().remove(&req_id);
        };
        Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response()
    } else {
        // Non-streaming: accumulate the full reply on a blocking thread, then
        // return one completion object.
        let result = tokio::task::spawn_blocking(move || {
            let mut acc = String::new();
            let on_token = |piece: String| -> bool {
                acc.push_str(&piece);
                true
            };
            inference::generate_blocking(&backend, &loaded_for_task, gen, cancel_for_task, on_token)
                .map(|tps| {
                    *tps_slot.lock().unwrap() = tps;
                    acc
                })
        })
        .await;

        deregister();

        match result {
            Ok(Ok(text)) => Json(json!({
                "id": id,
                "object": "chat.completion",
                "created": created,
                "model": model_label,
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": text },
                    "finish_reason": "stop",
                }],
            }))
            .into_response(),
            Ok(Err(e)) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": { "message": e } })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": { "message": format!("inference task panicked: {e}") } })),
            )
                .into_response(),
        }
    }
}

/// Cancel every in-flight generation. Returns within milliseconds; each
/// generation loop observes its own flag between tokens and stops. ÄKÄ runs
/// one generation at a time today, but cancelling all is safe for future
/// concurrency.
async fn abort_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let map = state.active_requests.lock().unwrap();
    let cancelled = map.len();
    for flag in map.values() {
        flag.store(true, Ordering::SeqCst);
    }
    Json(json!({ "aborted": true, "requests_cancelled": cancelled }))
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
