use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::commands::message_validator as validator;
use crate::commands::project_config::load_from_disk;
use crate::error::AppError;

const EVT_LLM_CHUNK: &str = "llm://chunk";
const EVT_LLM_DONE: &str = "llm://done";
const EVT_LLM_ERROR: &str = "llm://error";
/// Surfaced whenever AKA makes an outbound LLM call to a *non-loopback* endpoint
/// — a `network` action, never a silent default (Task 8). `allowed:false` means
/// the call was blocked (endpoint not in `capabilities.network_allowlist`).
const EVT_NETWORK_EGRESS: &str = "network://egress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkEgressPayload {
    url: String,
    host: String,
    allowed: bool,
}

/// Gate an outbound LLM base URL as a `network` action (Task 8 — cloud is an
/// optional adapter, never a dependency). Loopback (the local sidecar / local
/// runtimes) is local-first and ungated. A remote endpoint must be allowlisted in
/// `.äkä/config.json` (`capabilities.network_allowlist`); either way it is surfaced
/// to the UI as a network action. Returns the blocked URL if denied so callers can
/// fall back to a local runtime rather than hanging on the network.
fn gate_egress(
    app: &AppHandle,
    base_url: &str,
    caps: &crate::commands::project_config::CapabilitiesBlock,
) -> Result<(), AppError> {
    use crate::tools::policy::{host_of, network_egress, EgressDecision};
    // Route through the same `Limits` the policy layer enforces, so cloud egress
    // is governed by exactly the `network` deny-by-default rule, not a parallel one.
    let limits = caps.limits();
    match network_egress(base_url, &limits.network_allowlist) {
        // Local-first path: never gated, never surfaced as a network action.
        EgressDecision::Loopback => Ok(()),
        EgressDecision::Allowlisted => {
            let _ = app.emit(
                EVT_NETWORK_EGRESS,
                NetworkEgressPayload {
                    url: base_url.to_string(),
                    host: host_of(base_url).unwrap_or_default(),
                    allowed: true,
                },
            );
            Ok(())
        }
        EgressDecision::Denied => {
            let _ = app.emit(
                EVT_NETWORK_EGRESS,
                NetworkEgressPayload {
                    url: base_url.to_string(),
                    host: host_of(base_url).unwrap_or_default(),
                    allowed: false,
                },
            );
            Err(AppError::network_blocked(base_url))
        }
    }
}

/// Cancellation flags for in-flight LLM streams, keyed by run id (the session
/// that launched the stream). Each session streams independently: starting a
/// new stream for the *same* run id supersedes that run's previous stream,
/// while other runs are untouched — so multiple sessions stream concurrently.
#[derive(Default)]
pub struct LlmStreamState {
    streams: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkPayload {
    run_id: String,
    text: String,
    /// Reasoning delta for runtimes that stream thinking as its own field
    /// (Ollama's `reasoning`, DeepSeek-style `reasoning_content`) instead of
    /// inline <think> tags. Mutually exclusive with `text` per event.
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    run_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    run_id: String,
    message: String,
}

/// Strip model reasoning from a completed (non-streamed) response so it never
/// leaks into machine-consumed strings (self-correction prompts, handoff
/// summaries). Removes <think>…</think> / <thinking>…</thinking> blocks, and
/// handles templates that prefill the opening tag — where the model only ever
/// emits a closing tag — by treating everything before an orphan close tag as
/// reasoning.
fn strip_think(s: &str) -> String {
    const OPEN_TAGS: [&str; 2] = ["<thinking>", "<think>"];
    const CLOSE_TAGS: [&str; 2] = ["</thinking>", "</think>"];

    fn find_first(s: &str, tags: &[&str]) -> Option<(usize, usize)> {
        tags.iter()
            .filter_map(|t| s.find(t).map(|i| (i, t.len())))
            .min_by_key(|&(i, _)| i)
    }

    let mut out = String::new();
    let mut rest = s;
    let mut in_think = false;
    loop {
        if in_think {
            match find_first(rest, &CLOSE_TAGS) {
                Some((i, len)) => {
                    rest = &rest[i + len..];
                    in_think = false;
                }
                // Unterminated thinking block — drop the tail.
                None => break,
            }
        } else {
            let open = find_first(rest, &OPEN_TAGS);
            let close = find_first(rest, &CLOSE_TAGS);
            match (open, close) {
                // Close tag with no opener before it: the opener lived in the
                // prompt template, so everything up to here was reasoning.
                (o, Some((ci, clen))) if o.is_none_or(|(oi, _)| ci < oi) => {
                    out.clear();
                    rest = &rest[ci + clen..];
                }
                (Some((oi, olen)), _) => {
                    out.push_str(&rest[..oi]);
                    rest = &rest[oi + olen..];
                    in_think = true;
                }
                // No more tags (close-before-open is caught by the first arm,
                // so a remaining Some(close) here is unreachable).
                (None, _) => {
                    out.push_str(rest);
                    break;
                }
            }
        }
    }
    out.trim().to_string()
}

const SUMMARIZER_SYSTEM_PROMPT: &str = "You are a session summarizer. Given a conversation history, return a concise summary covering: the original task, what was completed, what files were changed, and what remains unfinished. Be brief — 100 words maximum.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRuntime {
    pub name: String,
    pub base_url: String,
    /// The port responded to `GET /models` — the runtime is up right now.
    pub healthy: bool,
    /// The runtime is present on this machine (CLI binary or app bundle found),
    /// even if it isn't running. Lets the UI hide runtimes the user doesn't have
    /// instead of showing them as dead rows.
    pub installed: bool,
    /// AKA spawned this runtime's server and holds its process handle, so it can
    /// stop it. Drives the Stop button.
    pub managed: bool,
    /// AKA knows a headless command to boot this runtime as a child process it
    /// owns. Drives whether a Play button is offered.
    pub launchable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub content: MessageContent,
}

/// A chat message's content. Mirrors the OpenAI surface: either a plain string
/// or an array of typed parts (text + images). Vision-capable runtimes accept
/// the parts form with base64 `data:` URLs on the same `/chat/completions`
/// path, so no provider-specific handling is needed. `#[serde(untagged)]` makes
/// it round-trip whichever shape the frontend sends.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text { text: String },
    ImageUrl { image_url: ImageUrl },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageUrl {
    pub url: String,
}

impl MessageContent {
    /// Flatten to plain text — verbatim for the string variant, or the joined
    /// text parts (images dropped) for the parts variant. Used by the
    /// summarizer, which works on a textual transcript.
    fn as_text(&self) -> String {
        match self {
            MessageContent::Text(s) => s.clone(),
            MessageContent::Parts(parts) => parts
                .iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } => Some(text.as_str()),
                    ContentPart::ImageUrl { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [Message],
}

// ---------- Native tool-calling (the built-in "None" agent loop) ----------

/// One tool advertised to the model — the OpenAI `tools` entry shape. Built
/// host-side from the capability catalog (see `tools::loop_tools`); the frontend
/// never invents these, so the model can only ever be offered house tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ToolFunctionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunctionDef {
    pub name: String,
    pub description: String,
    /// JSON Schema for the call arguments.
    pub parameters: serde_json::Value,
}

/// A tool call the model emitted, exactly as the provider returns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    /// Raw JSON string of arguments, as the provider returns it.
    #[serde(default)]
    pub arguments: String,
}

/// One assistant turn in the tool loop: final text (when done), any tool calls
/// to execute, and reasoning (for the witness timeline). Exactly one of
/// `content` / `tool_calls` is normally populated per turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurn {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub reasoning: Option<String>,
}

#[derive(Debug, Serialize)]
struct ToolChatRequest<'a> {
    model: &'a str,
    /// Raw OpenAI message objects, so the frontend can carry the full loop
    /// history (assistant `tool_calls`, `tool` results) without each variant
    /// being rigidly typed here.
    messages: &'a [serde_json::Value],
    tools: &'a [ToolDef],
    tool_choice: &'a str,
}

#[derive(Debug, Deserialize)]
struct ToolChatResponse {
    choices: Vec<ToolChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ToolChatChoice {
    message: ToolChatMessage,
}

#[derive(Debug, Deserialize)]
struct ToolChatMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCall>>,
    // Providers expose streamed-thinking under different keys when non-streamed.
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

/// Run one non-streamed tool-calling turn against the project's runtime. This is
/// the native half of the built-in "None" agent: AKA supplies the `tools`, the
/// model either calls one or returns a final answer, and the frontend loop drives
/// the rest. Non-streamed on purpose — assembling streamed `tool_calls` deltas is
/// brittle across local runtimes, and a tool turn has no user-visible streaming
/// value (the final answer turn still streams via `call_llm_stream`).
///
/// Cloud egress is gated exactly like every other LLM call (`gate_egress`), so the
/// loop never reaches a non-allowlisted remote endpoint.
#[tauri::command]
pub async fn call_llm_tools(
    app: AppHandle,
    messages: Vec<serde_json::Value>,
    tools: Vec<ToolDef>,
    project_path: String,
    model: Option<String>,
) -> Result<AssistantTurn, AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::RuntimeOffline);
    }
    // Last gate before the provider: normalize the loop history so no provider
    // ever sees an empty/malformed message. Refuse (client-side) when nothing
    // valid remains instead of sending a request we know is invalid.
    let (messages, removed) = validator::sanitize(&messages);
    validator::log_removals(&removed);
    if !validator::has_non_system(&messages) {
        return Err(AppError::invalid_conversation());
    }
    let cfg = load_from_disk(&project_path).await?;
    gate_egress(&app, &cfg.runtime.base_url, &cfg.capabilities)?;
    let runtime = cfg.runtime;
    let model_id = model.filter(|m| !m.is_empty()).unwrap_or(runtime.model);
    if model_id.is_empty() {
        return Err(AppError::RuntimeOffline);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| AppError::RuntimeOffline)?;

    use crate::commands::providers::{
        anthropic_request, chat_url, google_chat_url, google_request, parse_anthropic_response,
        parse_google_response, resolve_provider, Provider,
    };
    let provider = resolve_provider(runtime.provider.as_deref(), &runtime.base_url);
    let req = match provider {
        Provider::OpenAiCompatible => client
            .post(chat_url(provider, &runtime.base_url))
            .json(&ToolChatRequest {
                model: &model_id,
                messages: &messages,
                tools: &tools,
                tool_choice: "auto",
            }),
        Provider::Anthropic => {
            let tool_values: Vec<serde_json::Value> = tools
                .iter()
                .filter_map(|t| serde_json::to_value(t).ok())
                .collect();
            client
                .post(chat_url(provider, &runtime.base_url))
                .json(&anthropic_request(
                    &model_id,
                    &messages,
                    Some(&tool_values),
                    false,
                    None,
                    None,
                ))
        }
        Provider::Google => {
            let tool_values: Vec<serde_json::Value> = tools
                .iter()
                .filter_map(|t| serde_json::to_value(t).ok())
                .collect();
            client
                .post(google_chat_url(&runtime.base_url, &model_id, false))
                .json(&google_request(&messages, Some(&tool_values), None, None))
        }
    };
    let req = apply_provider_auth(req, provider, runtime.api_key.as_deref());

    // Transport failure (connect/timeout) = runtime offline. A non-2xx answer
    // is a different animal: the endpoint is up and rejected the request — an
    // API error, surfaced with the provider's own message.
    let resp = req.send().await.map_err(|_| AppError::RuntimeOffline)?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::provider_rejected(
            status.as_u16(),
            crate::commands::providers::provider_error_message(&body),
        ));
    }
    match provider {
        Provider::OpenAiCompatible => {
            let body: ToolChatResponse = resp.json().await.map_err(|_| AppError::RuntimeOffline)?;
            let msg = body
                .choices
                .into_iter()
                .next()
                .map(|c| c.message)
                .ok_or(AppError::RuntimeOffline)?;
            let content = msg.content.as_deref().map(strip_think).filter(|s| !s.is_empty());
            let reasoning = msg.reasoning.or(msg.reasoning_content).filter(|s| !s.trim().is_empty());
            Ok(AssistantTurn {
                content,
                tool_calls: msg.tool_calls.unwrap_or_default(),
                reasoning,
            })
        }
        Provider::Anthropic | Provider::Google => {
            let body: serde_json::Value =
                resp.json().await.map_err(|_| AppError::RuntimeOffline)?;
            let turn = if provider == Provider::Anthropic {
                parse_anthropic_response(&body)
            } else {
                parse_google_response(&body)
            };
            Ok(AssistantTurn {
                content: turn.content,
                tool_calls: turn
                    .tool_calls
                    .into_iter()
                    .map(|(id, name, arguments)| ToolCall {
                        id,
                        kind: Some("function".into()),
                        function: ToolCallFunction { name, arguments },
                    })
                    .collect(),
                reasoning: turn.reasoning,
            })
        }
    }
}

/// A local runtime we know how to look for. `base_url` is its published default
/// OpenAI-compatible endpoint; `binaries` / `app_bundles` are the signals that
/// tell us it's *installed* even when it isn't running, so the UI can hide
/// runtimes the user doesn't have rather than showing dead rows.
/// A command AKA can run to boot a runtime as a child process it owns (so it
/// can stop it too). `program` is resolved against the search path at launch.
struct Launch {
    program: &'static str,
    args: &'static [&'static str],
}

struct Probe {
    name: &'static str,
    base_url: &'static str,
    /// CLI executables that indicate this runtime is installed (any match).
    binaries: &'static [&'static str],
    /// macOS app-bundle names (without `.app`) that indicate it's installed.
    app_bundles: &'static [&'static str],
    /// How AKA boots this runtime headlessly. `None` for runtimes it can't
    /// cleanly start+stop — GUI-only (LM Studio, Jan) or model-required
    /// (llama.cpp). Those keep their Install link / manual start.
    launch: Option<Launch>,
}

/// Local runtimes auto-detected on startup (and on the 5s background poll).
/// Each is probed with a 1s `GET {base_url}/models` for liveness plus a
/// filesystem check for install status. Ports are each server's published
/// default — except MLX: `mlx_lm.server` also defaults to 8080, which collides
/// with llama.cpp, and two probes can't share a base URL (the panel keys rows
/// by URL). So we probe MLX on 8081; launch it there with
/// `mlx_lm.server --port 8081`. Anything on a non-default port can still be
/// added via "Add custom endpoint".
const PROBES: &[Probe] = &[
    Probe {
        name: "Ollama",
        base_url: "http://localhost:11434/v1",
        binaries: &["ollama"],
        app_bundles: &["Ollama"],
        launch: Some(Launch {
            program: "ollama",
            args: &["serve"],
        }),
    },
    Probe {
        name: "LM Studio",
        base_url: "http://localhost:1234/v1",
        binaries: &["lms"],
        app_bundles: &["LM Studio"],
        launch: None,
    },
    Probe {
        name: "llama.cpp",
        base_url: "http://localhost:8080/v1",
        binaries: &["llama-server", "llama-cli"],
        app_bundles: &[],
        launch: None,
    },
    Probe {
        name: "MLX",
        base_url: "http://localhost:8081/v1",
        binaries: &["mlx_lm.server"],
        app_bundles: &[],
        // Boot on 8081 to match our probe (its default 8080 collides with
        // llama.cpp). Starts with no model — it loads per request; you still
        // need a model downloaded to actually answer.
        launch: Some(Launch {
            program: "mlx_lm.server",
            args: &["--port", "8081"],
        }),
    },
    Probe {
        name: "Jan",
        base_url: "http://localhost:1337/v1",
        binaries: &[],
        app_bundles: &["Jan"],
        launch: None,
    },
];

/// Directories to search for runtime CLIs, on top of the process `PATH`. A
/// macOS app launched from Finder/Dock doesn't inherit the user's shell `PATH`,
/// so we also check the common Homebrew and pip/pipx user-install locations —
/// enough to spot `ollama`, `llama-server`, `mlx_lm.server`, etc. without
/// spawning a login shell.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        // pip `--user` on macOS system Python lands in ~/Library/Python/<ver>/bin.
        if let Ok(entries) = std::fs::read_dir(home.join("Library/Python")) {
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin"));
            }
        }
    }
    dirs
}

/// Whether a runtime is installed: any of its CLI binaries is on the search
/// path, or any of its app bundles is present. Cheap filesystem stats — no
/// processes spawned.
fn is_installed(probe: &Probe, dirs: &[PathBuf]) -> bool {
    let has_binary = probe
        .binaries
        .iter()
        .any(|name| dirs.iter().any(|d| d.join(name).is_file()));
    if has_binary {
        return true;
    }
    if probe.app_bundles.is_empty() {
        return false;
    }
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    probe
        .app_bundles
        .iter()
        .any(|name| roots.iter().any(|r| r.join(format!("{name}.app")).exists()))
}

/// Apply a provider's auth headers to a request. The provider abstraction keeps
/// non-OpenAI APIs (Anthropic's `x-api-key` + version header) working through
/// the same seams as Bearer-auth endpoints.
fn apply_provider_auth(
    mut req: reqwest::RequestBuilder,
    provider: crate::commands::providers::Provider,
    api_key: Option<&str>,
) -> reqwest::RequestBuilder {
    for (name, value) in
        crate::commands::providers::auth_headers(provider, api_key.unwrap_or_default())
    {
        req = req.header(name, value);
    }
    req
}

async fn check_health(base_url: &str, api_key: Option<&str>) -> bool {
    use crate::commands::providers::{models_url, resolve_provider};
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let provider = resolve_provider(None, base_url);
    let req = apply_provider_auth(
        client.get(models_url(provider, base_url)),
        provider,
        api_key,
    );
    match req.send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn detect_runtimes(
    launcher: State<'_, RuntimeLauncher>,
) -> Result<Vec<DetectedRuntime>, String> {
    // Liveness probes run concurrently; install checks are cheap local stats.
    let health = join_all(PROBES.iter().map(|p| check_health(p.base_url, None))).await;
    let dirs = search_dirs();
    let managed: std::collections::HashSet<String> = {
        let guard = launcher.map.lock().await;
        guard.keys().cloned().collect()
    };
    Ok(PROBES
        .iter()
        .zip(health)
        .map(|(probe, healthy)| DetectedRuntime {
            name: probe.name.to_string(),
            base_url: probe.base_url.to_string(),
            healthy,
            installed: is_installed(probe, &dirs),
            managed: managed.contains(probe.name),
            launchable: probe.launch.is_some(),
        })
        .collect())
}

/// A runtime server AKA launched and now owns. `id` distinguishes generations
/// so a quick stop→start can't have the old child's wait-task evict the new
/// child's slot (cf. the stream-cancellation `Arc::ptr_eq` trick).
struct Managed {
    id: u64,
    kill: oneshot::Sender<()>,
}

/// Tracks the runtime servers AKA has booted, keyed by runtime name. Each
/// `Child` is owned by its own wait-task (never behind the lock during
/// `child.wait()`); the map only holds a kill channel — same shape as
/// `DevServerState`, generalized to many runtimes at once.
#[derive(Default)]
pub struct RuntimeLauncher {
    next_id: AtomicU64,
    map: Arc<Mutex<HashMap<String, Managed>>>,
}

/// Resolve a program name to an absolute path using the same search dirs as
/// install detection, falling back to the bare name (let the OS resolve it via
/// `PATH`, which `path_env::fix` has already repaired at startup).
fn resolve_program(program: &str, dirs: &[PathBuf]) -> PathBuf {
    dirs.iter()
        .map(|d| d.join(program))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(program))
}

/// Boot a runtime AKA knows how to launch. Idempotent — a second call while it's
/// already managed is a no-op. The server comes up in the background; the row
/// flips to healthy on the next detection poll once its port answers.
#[tauri::command]
pub async fn start_runtime(
    launcher: State<'_, RuntimeLauncher>,
    name: String,
) -> Result<(), String> {
    let probe = PROBES
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("Unknown runtime: {name}"))?;
    let launch = probe
        .launch
        .as_ref()
        .ok_or_else(|| format!("{name} can't be started by AKA"))?;

    // Already managing a live child for this runtime — nothing to do.
    {
        let guard = launcher.map.lock().await;
        if guard.contains_key(&name) {
            return Ok(());
        }
    }

    let dirs = search_dirs();
    let program = resolve_program(launch.program, &dirs);

    let mut cmd = Command::new(&program);
    cmd.args(launch.args);
    // Pipe stderr so a fast startup failure (bad args, missing model, port in
    // use — e.g. mlx_lm.server can exit immediately) surfaces as an error
    // instead of a silently dead row that never turns healthy.
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start {name} ({}): {e}", launch.program))?;

    // Give it a moment to fail fast. If it already exited, the launch failed —
    // read what it logged and report that, rather than returning Ok and leaving
    // a row that never goes green.
    tokio::time::sleep(Duration::from_millis(800)).await;
    if let Ok(Some(status)) = child.try_wait() {
        use tokio::io::AsyncReadExt;
        let mut buf = String::new();
        if let Some(mut err) = child.stderr.take() {
            let _ = err.read_to_string(&mut buf).await;
        }
        let tail = buf
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" • ");
        return Err(if tail.is_empty() {
            format!("{name} exited on startup ({status}) — is it installed and a model available?")
        } else {
            format!("{name} exited on startup ({status}): {tail}")
        });
    }

    // Survived startup. Drain stderr for the child's life so the piped buffer
    // can never fill and block the server.
    if let Some(mut err) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut sink = Vec::new();
            let _ = err.read_to_end(&mut sink).await;
        });
    }

    let id = launcher.next_id.fetch_add(1, Ordering::SeqCst);
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    {
        let mut guard = launcher.map.lock().await;
        guard.insert(name.clone(), Managed { id, kill: kill_tx });
    }

    // The wait-task OWNS the child (no shared lock during wait). It races a
    // natural exit against the Stop signal; either way it clears its own slot
    // on the way out — but only if it's still the current generation.
    let map = launcher.map.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = child.wait() => {}
            _ = kill_rx => {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        let mut guard = map.lock().await;
        if guard.get(&name).map(|m| m.id) == Some(id) {
            guard.remove(&name);
        }
    });

    Ok(())
}

/// Stop a runtime AKA started — fires its kill channel; the wait-task SIGKILLs
/// the child and clears the slot. Returns false if AKA wasn't managing it.
#[tauri::command]
pub async fn stop_runtime(
    launcher: State<'_, RuntimeLauncher>,
    name: String,
) -> Result<bool, String> {
    let managed = {
        let mut guard = launcher.map.lock().await;
        guard.remove(&name)
    };
    match managed {
        Some(m) => {
            let _ = m.kill.send(());
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn list_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    use crate::commands::providers::{models_url, resolve_provider};
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let provider = resolve_provider(None, &base_url);
    let req = apply_provider_auth(
        client.get(models_url(provider, &base_url)),
        provider,
        api_key.as_deref(),
    );
    let resp = req.send().await.map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    // Google's list shape is `{models:[{name:"models/…"}]}`; everyone else
    // (incl. Anthropic) speaks the OpenAI `{data:[{id}]}` shape.
    if provider == crate::commands::providers::Provider::Google {
        let body: serde_json::Value = resp.json().await.map_err(|e| format!("parse: {e}"))?;
        return Ok(crate::commands::providers::parse_google_models(&body));
    }
    let body: ModelsResponse = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    Ok(body.data.into_iter().map(|m| m.id).collect())
}

#[tauri::command]
pub async fn check_runtime_health(
    base_url: String,
    api_key: Option<String>,
) -> bool {
    check_health(&base_url, api_key.as_deref()).await
}

/// Call the LLM configured for `project_path`. Reads the runtime block from
/// the project config fresh — config is never cached between calls, so
/// switching a project's model or base URL takes effect immediately.
#[tauri::command]
pub async fn call_llm(
    app: AppHandle,
    messages: Vec<Message>,
    project_path: String,
    model: Option<String>,
) -> Result<String, AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::RuntimeOffline);
    }
    // Validate before any provider request (same gate as call_llm_tools).
    let (messages, removed) = validator::sanitize_typed(&messages);
    validator::log_removals(&removed);
    if !messages.iter().any(|m| m.role != "system") {
        return Err(AppError::invalid_conversation());
    }
    let cfg = load_from_disk(&project_path).await?;
    // Cloud = a `network` action: loopback is ungated, remote must be allowlisted.
    gate_egress(&app, &cfg.runtime.base_url, &cfg.capabilities)?;
    let runtime = cfg.runtime;
    let model_id = model.filter(|m| !m.is_empty()).unwrap_or(runtime.model);
    if model_id.is_empty() {
        return Err(AppError::RuntimeOffline);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| AppError::RuntimeOffline)?;

    use crate::commands::providers::{
        anthropic_request, chat_url, google_chat_url, google_request, parse_anthropic_response,
        parse_google_response, resolve_provider, Provider,
    };
    let provider = resolve_provider(runtime.provider.as_deref(), &runtime.base_url);
    let req = match provider {
        Provider::OpenAiCompatible => client
            .post(chat_url(provider, &runtime.base_url))
            .json(&ChatRequest {
                model: &model_id,
                messages: &messages,
            }),
        Provider::Anthropic => {
            let msgs: Vec<serde_json::Value> = messages
                .iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .collect();
            client
                .post(chat_url(provider, &runtime.base_url))
                .json(&anthropic_request(&model_id, &msgs, None, false, None, None))
        }
        Provider::Google => {
            let msgs: Vec<serde_json::Value> = messages
                .iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .collect();
            client
                .post(google_chat_url(&runtime.base_url, &model_id, false))
                .json(&google_request(&msgs, None, None, None))
        }
    };
    let req = apply_provider_auth(req, provider, runtime.api_key.as_deref());

    // Connection or timeout errors == runtime offline ("start your local
    // server"). A non-2xx answer is an API error — the endpoint is up and
    // rejected the request — surfaced with the provider's own message.
    let resp = req.send().await.map_err(|_| AppError::RuntimeOffline)?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::provider_rejected(
            status.as_u16(),
            crate::commands::providers::provider_error_message(&body),
        ));
    }
    match provider {
        Provider::OpenAiCompatible => {
            let body: ChatCompletionResponse =
                resp.json().await.map_err(|_| AppError::RuntimeOffline)?;
            body.choices
                .into_iter()
                .next()
                .and_then(|c| c.message.content)
                .map(|s| strip_think(&s))
                .ok_or(AppError::RuntimeOffline)
        }
        Provider::Anthropic | Provider::Google => {
            let body: serde_json::Value =
                resp.json().await.map_err(|_| AppError::RuntimeOffline)?;
            let turn = if provider == Provider::Anthropic {
                parse_anthropic_response(&body)
            } else {
                parse_google_response(&body)
            };
            turn.content
                .map(|s| strip_think(&s))
                .ok_or(AppError::RuntimeOffline)
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizerRuntime {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

/// Summarize a session's message history using the *outgoing* runtime so the
/// summary can be handed to a newly-selected model or agent. The runtime is
/// always passed explicitly — never loaded from project config — because at
/// handoff time the project config may already reflect the *incoming* model.
#[tauri::command]
pub async fn summarize_session(
    messages: Vec<Message>,
    runtime: SummarizerRuntime,
) -> Result<String, AppError> {
    if runtime.model.trim().is_empty() || runtime.base_url.trim().is_empty() {
        return Err(AppError::SummarizationFailed);
    }

    let history = messages
        .iter()
        .map(|m| format!("[{}]\n{}", m.role, m.content.as_text()))
        .collect::<Vec<_>>()
        .join("\n\n");

    let summary_messages = vec![
        Message {
            role: "system".to_string(),
            content: MessageContent::Text(SUMMARIZER_SYSTEM_PROMPT.to_string()),
        },
        Message {
            role: "user".to_string(),
            content: MessageContent::Text(history),
        },
    ];
    // Same pre-flight gate as every provider path: an empty history would
    // otherwise produce an empty user message the provider rejects.
    let (summary_messages, removed) = validator::sanitize_typed(&summary_messages);
    validator::log_removals(&removed);
    if !summary_messages.iter().any(|m| m.role != "system") {
        return Err(AppError::SummarizationFailed);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| AppError::SummarizationFailed)?;

    use crate::commands::providers::{
        anthropic_request, chat_url, google_chat_url, google_request, parse_anthropic_response,
        parse_google_response, resolve_provider, Provider,
    };
    let provider = resolve_provider(None, &runtime.base_url);
    let req = match provider {
        Provider::OpenAiCompatible => client
            .post(chat_url(provider, &runtime.base_url))
            .json(&ChatRequest {
                model: &runtime.model,
                messages: &summary_messages,
            }),
        Provider::Anthropic => {
            let msgs: Vec<serde_json::Value> = summary_messages
                .iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .collect();
            client
                .post(chat_url(provider, &runtime.base_url))
                .json(&anthropic_request(&runtime.model, &msgs, None, false, None, None))
        }
        Provider::Google => {
            let msgs: Vec<serde_json::Value> = summary_messages
                .iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .collect();
            client
                .post(google_chat_url(&runtime.base_url, &runtime.model, false))
                .json(&google_request(&msgs, None, None, None))
        }
    };
    let req = apply_provider_auth(req, provider, runtime.api_key.as_deref());

    let resp = req.send().await.map_err(|_| AppError::SummarizationFailed)?;
    if !resp.status().is_success() {
        return Err(AppError::SummarizationFailed);
    }
    let content = match provider {
        Provider::OpenAiCompatible => {
            let body: ChatCompletionResponse = resp
                .json()
                .await
                .map_err(|_| AppError::SummarizationFailed)?;
            body.choices.into_iter().next().and_then(|c| c.message.content)
        }
        Provider::Anthropic | Provider::Google => {
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|_| AppError::SummarizationFailed)?;
            if provider == Provider::Anthropic {
                parse_anthropic_response(&body).content
            } else {
                parse_google_response(&body).content
            }
        }
    };
    content
        .map(|s| strip_think(&s))
        .filter(|s| !s.is_empty())
        .ok_or(AppError::SummarizationFailed)
}

/// AKA's accuracy-leaning sampling defaults, applied when a project hasn't set
/// its own (`RuntimeBlock.temperature` / `top_p` are `None`). Low temperature
/// noticeably tightens instruction-following on small local models.
const DEFAULT_TEMPERATURE: f32 = 0.15;
const DEFAULT_TOP_P: f32 = 0.9;

#[derive(Debug, Serialize)]
struct ChatStreamRequest<'a> {
    model: &'a str,
    messages: &'a [Message],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f32>,
}

/// Stream a chat completion from the project's runtime. Token deltas are
/// emitted as `llm://chunk` events (payload: string). `llm://done` fires
/// once the upstream stream closes; `llm://error` fires with a string
/// payload on any failure (network, HTTP non-2xx, parse). Starting a new
/// stream cancels the previous one.
#[tauri::command]
pub async fn call_llm_stream(
    app: AppHandle,
    state: State<'_, LlmStreamState>,
    messages: Vec<Message>,
    project_path: String,
    model: Option<String>,
    run_id: Option<String>,
) -> Result<(), String> {
    // A stable id for this stream so its chunk/done/error events route to the
    // session that launched it. Supplied per-session by the caller; minted here
    // as a fallback so legacy callers still work.
    let run_id = run_id.unwrap_or_else(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("llm-{}-{}", std::process::id(), nanos)
    });

    // Install our cancellation flag under this run id, superseding only this
    // run's previous stream (if the session re-submitted). Other runs untouched.
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut streams = state.streams.lock().await;
        if let Some(prev) = streams.insert(run_id.clone(), cancel.clone()) {
            prev.store(true, Ordering::SeqCst);
        }
    }

    let result = run_stream(&app, &run_id, &cancel, messages, project_path, model).await;

    // Clear our slot only if we're still the active stream for this run id —
    // a newer call for the same run may already have replaced us.
    {
        let mut streams = state.streams.lock().await;
        if let Some(current) = streams.get(&run_id) {
            if Arc::ptr_eq(current, &cancel) {
                streams.remove(&run_id);
            }
        }
    }

    match result {
        Ok(()) => {
            let _ = app.emit(
                EVT_LLM_DONE,
                DonePayload {
                    run_id: run_id.clone(),
                },
            );
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                EVT_LLM_ERROR,
                ErrorPayload {
                    run_id: run_id.clone(),
                    message: e.clone(),
                },
            );
            Err(e)
        }
    }
}

async fn run_stream(
    app: &AppHandle,
    run_id: &str,
    cancel: &Arc<AtomicBool>,
    messages: Vec<Message>,
    project_path: String,
    model: Option<String>,
) -> Result<(), String> {
    if project_path.trim().is_empty() {
        return Err("No project open — runtime config unavailable".into());
    }
    // Validate before any provider request (same gate as the non-streamed paths).
    let (messages, removed) = validator::sanitize_typed(&messages);
    validator::log_removals(&removed);
    if !messages.iter().any(|m| m.role != "system") {
        return Err(validator::EMPTY_CONVERSATION.to_string());
    }
    let mut messages = messages;
    let cfg = load_from_disk(&project_path)
        .await
        .map_err(|e| format!("{e:?}"))?;
    // Cloud egress is a `network` action (Task 8). Loopback is local-first and
    // ungated; a remote endpoint must be allowlisted, and is surfaced either way.
    gate_egress(app, &cfg.runtime.base_url, &cfg.capabilities).map_err(|e| e.to_string())?;
    let runtime = cfg.runtime;
    let model_id = model.filter(|m| !m.is_empty()).unwrap_or(runtime.model);
    if model_id.is_empty() {
        return Err("No model selected".into());
    }

    // Prepend the project's system prompt — but only when the caller didn't
    // already supply one (the summarizer/correction paths build their own).
    if let Some(sp) = runtime.system_prompt.as_deref() {
        if !sp.trim().is_empty() && !messages.iter().any(|m| m.role == "system") {
            messages.insert(
                0,
                Message {
                    role: "system".into(),
                    content: MessageContent::Text(sp.to_string()),
                },
            );
        }
    }

    // Sampling: honor the project's values, else fall back to AKA's
    // accuracy-leaning defaults so sharpening applies out of the box.
    let temperature = Some(runtime.temperature.unwrap_or(DEFAULT_TEMPERATURE));
    let top_p = Some(runtime.top_p.unwrap_or(DEFAULT_TOP_P));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    use crate::commands::providers::{
        anthropic_request, chat_url, google_chat_url, google_request, parse_anthropic_sse,
        parse_google_sse, resolve_provider, Provider, StreamDelta,
    };
    let provider = resolve_provider(runtime.provider.as_deref(), &runtime.base_url);
    let req = match provider {
        Provider::OpenAiCompatible => client
            .post(chat_url(provider, &runtime.base_url))
            .json(&ChatStreamRequest {
                model: &model_id,
                messages: &messages,
                stream: true,
                temperature,
                top_p,
            }),
        Provider::Anthropic => {
            let msgs: Vec<serde_json::Value> = messages
                .iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .collect();
            client
                .post(chat_url(provider, &runtime.base_url))
                .json(&anthropic_request(&model_id, &msgs, None, true, temperature, top_p))
        }
        Provider::Google => {
            let msgs: Vec<serde_json::Value> = messages
                .iter()
                .filter_map(|m| serde_json::to_value(m).ok())
                .collect();
            client
                .post(google_chat_url(&runtime.base_url, &model_id, true))
                .json(&google_request(&msgs, None, temperature, top_p))
        }
    };
    let req = apply_provider_auth(req, provider, runtime.api_key.as_deref());

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        // Include the provider's own message so the frontend can surface an
        // API error (key, rate limit, bad request) instead of "runtime offline".
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            crate::commands::providers::provider_error_message(&body)
        ));
    }

    let mut stream = resp.bytes_stream();
    // SSE parser: accumulate raw bytes, split on newlines, look for `data: …`.
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Ok(()); // user-requested stop — not an error
        }
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        // Drain complete lines.
        loop {
            let Some(idx) = buf.find('\n') else { break };
            let line = buf[..idx].trim_end_matches('\r').to_string();
            buf.drain(..=idx);
            if !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            // Anthropic streams typed events (`content_block_delta`), Gemini
            // streams whole response chunks — neither is OpenAI's
            // choices[].delta. Translate onto the same chunk events and move on.
            if provider != Provider::OpenAiCompatible {
                let delta = if provider == Provider::Anthropic {
                    parse_anthropic_sse(&json)
                } else {
                    parse_google_sse(&json)
                };
                match delta {
                    Some(StreamDelta::Text(text)) => {
                        let _ = app.emit(
                            EVT_LLM_CHUNK,
                            ChunkPayload {
                                run_id: run_id.to_string(),
                                text,
                                thinking: None,
                            },
                        );
                    }
                    Some(StreamDelta::Thinking(thinking)) => {
                        let _ = app.emit(
                            EVT_LLM_CHUNK,
                            ChunkPayload {
                                run_id: run_id.to_string(),
                                text: String::new(),
                                thinking: Some(thinking),
                            },
                        );
                    }
                    None => {}
                }
                continue;
            }
            let delta = &json["choices"][0]["delta"];
            // Runtimes with native thinking support (Ollama's `reasoning`,
            // DeepSeek-style `reasoning_content`) stream reasoning as its own
            // delta field rather than inline <think> tags — forward it
            // separately so the UI routes it straight to the Reasoning
            // accordion.
            if let Some(thinking) = delta["reasoning"]
                .as_str()
                .or_else(|| delta["reasoning_content"].as_str())
            {
                if !thinking.is_empty() {
                    let _ = app.emit(
                        EVT_LLM_CHUNK,
                        ChunkPayload {
                            run_id: run_id.to_string(),
                            text: String::new(),
                            thinking: Some(thinking.to_string()),
                        },
                    );
                }
            }
            if let Some(text) = delta["content"].as_str() {
                if !text.is_empty() {
                    let _ = app.emit(
                        EVT_LLM_CHUNK,
                        ChunkPayload {
                            run_id: run_id.to_string(),
                            text: text.to_string(),
                            thinking: None,
                        },
                    );
                }
            }
        }
    }

    Ok(())
}

/// Cancel an in-flight stream. Pass a `run_id` to stop just that session's
/// stream; omit it to stop every live stream. Returns true if anything was
/// running.
#[tauri::command]
pub async fn stop_llm_stream(
    state: State<'_, LlmStreamState>,
    run_id: Option<String>,
) -> Result<bool, String> {
    let mut streams = state.streams.lock().await;
    match run_id {
        Some(id) => match streams.remove(&id) {
            Some(token) => {
                token.store(true, Ordering::SeqCst);
                Ok(true)
            }
            None => Ok(false),
        },
        None => {
            let any = !streams.is_empty();
            for (_, token) in streams.drain() {
                token.store(true, Ordering::SeqCst);
            }
            Ok(any)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::strip_think;

    #[test]
    fn strips_tagged_block() {
        assert_eq!(strip_think("<think>plan</think>answer"), "answer");
        assert_eq!(strip_think("<thinking>plan</thinking>answer"), "answer");
    }

    #[test]
    fn strips_orphan_close() {
        // Template-prefilled opener: only the close tag is ever emitted.
        assert_eq!(strip_think("reasoning here</think>\nthe summary"), "the summary");
    }

    #[test]
    fn strips_multiple_blocks() {
        assert_eq!(strip_think("<think>a</think>one<think>b</think> two"), "one two");
    }

    #[test]
    fn drops_unterminated_thinking() {
        assert_eq!(strip_think("<think>never closed"), "");
    }

    #[test]
    fn passes_plain_text_through() {
        assert_eq!(strip_think("  just an answer  "), "just an answer");
        assert_eq!(strip_think("use <thead> and <div>"), "use <thead> and <div>");
    }
}
