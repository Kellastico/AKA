use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::commands::project_config::load_from_disk;
use crate::error::AppError;

const EVT_LLM_CHUNK: &str = "llm://chunk";
const EVT_LLM_DONE: &str = "llm://done";
const EVT_LLM_ERROR: &str = "llm://error";

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
    pub healthy: bool,
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

const PROBES: &[(&str, &str)] = &[
    ("Ollama", "http://localhost:11434/v1"),
    ("LM Studio", "http://localhost:1234/v1"),
    ("llama.cpp", "http://localhost:8080/v1"),
];

async fn probe_one(name: &'static str, base_url: &'static str) -> DetectedRuntime {
    let healthy = check_health(base_url, None).await;
    DetectedRuntime {
        name: name.to_string(),
        base_url: base_url.to_string(),
        healthy,
    }
}

async fn check_health(base_url: &str, api_key: Option<&str>) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let mut req = client.get(format!("{}/models", base_url.trim_end_matches('/')));
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }
    match req.send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn detect_runtimes() -> Vec<DetectedRuntime> {
    let futures = PROBES
        .iter()
        .map(|(name, url)| probe_one(name, url))
        .collect::<Vec<_>>();
    join_all(futures).await
}

#[tauri::command]
pub async fn list_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let mut req = client.get(format!("{}/models", base_url.trim_end_matches('/')));
    if let Some(key) = api_key.as_deref() {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }
    let resp = req.send().await.map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
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
    messages: Vec<Message>,
    project_path: String,
    model: Option<String>,
) -> Result<String, AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::RuntimeOffline);
    }
    let cfg = load_from_disk(&project_path).await?;
    let runtime = cfg.runtime;
    let model_id = model.filter(|m| !m.is_empty()).unwrap_or(runtime.model);
    if model_id.is_empty() {
        return Err(AppError::RuntimeOffline);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| AppError::RuntimeOffline)?;

    let mut req = client
        .post(format!(
            "{}/chat/completions",
            runtime.base_url.trim_end_matches('/')
        ))
        .json(&ChatRequest {
            model: &model_id,
            messages: &messages,
        });
    if let Some(key) = runtime.api_key.as_deref() {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    // Connection or timeout errors == runtime offline. Anything else (HTTP
    // 5xx, malformed body) also folds into RuntimeOffline so the UI can
    // surface the same actionable banner: "start your local server."
    let resp = req.send().await.map_err(|_| AppError::RuntimeOffline)?;
    if !resp.status().is_success() {
        return Err(AppError::RuntimeOffline);
    }
    let body: ChatCompletionResponse = resp.json().await.map_err(|_| AppError::RuntimeOffline)?;
    body.choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .map(|s| strip_think(&s))
        .ok_or(AppError::RuntimeOffline)
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

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| AppError::SummarizationFailed)?;

    let mut req = client
        .post(format!(
            "{}/chat/completions",
            runtime.base_url.trim_end_matches('/')
        ))
        .json(&ChatRequest {
            model: &runtime.model,
            messages: &summary_messages,
        });
    if let Some(key) = runtime.api_key.as_deref() {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let resp = req.send().await.map_err(|_| AppError::SummarizationFailed)?;
    if !resp.status().is_success() {
        return Err(AppError::SummarizationFailed);
    }
    let body: ChatCompletionResponse = resp
        .json()
        .await
        .map_err(|_| AppError::SummarizationFailed)?;
    body.choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .map(|s| strip_think(&s))
        .filter(|s| !s.is_empty())
        .ok_or(AppError::SummarizationFailed)
}

#[derive(Debug, Serialize)]
struct ChatStreamRequest<'a> {
    model: &'a str,
    messages: &'a [Message],
    stream: bool,
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
    let cfg = load_from_disk(&project_path)
        .await
        .map_err(|e| format!("{e:?}"))?;
    let runtime = cfg.runtime;
    let model_id = model.filter(|m| !m.is_empty()).unwrap_or(runtime.model);
    if model_id.is_empty() {
        return Err("No model selected".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client
        .post(format!(
            "{}/chat/completions",
            runtime.base_url.trim_end_matches('/')
        ))
        .json(&ChatStreamRequest {
            model: &model_id,
            messages: &messages,
            stream: true,
        });
    if let Some(key) = runtime.api_key.as_deref() {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
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
