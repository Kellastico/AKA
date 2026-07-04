//! Provider adapters — how AKA speaks to non-OpenAI-compatible LLM APIs.
//!
//! AKA's native wire shape is OpenAI-compatible (`/chat/completions`, Bearer
//! auth). This module adds per-provider translation so a user can paste a
//! provider's real endpoint + key into the SAME Add-custom-endpoint box and have
//! it work: today **Anthropic** (`/v1/messages`, `x-api-key`, content blocks);
//! the enum leaves room for Google next.
//!
//! Everything here is **pure** (JSON in → JSON out, no IO), so each mapping is
//! unit-tested without a network. `llm.rs` calls these at its existing seams:
//! request build, response parse, SSE-line parse, models URL, and auth headers.
//! Egress gating, cancellation, and event emission stay in `llm.rs` — one
//! enforcement path regardless of provider.

use serde_json::{json, Value};

/// Anthropic API version header — pinned, bumped deliberately.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic requires `max_tokens`; this is a generous ceiling, not a target.
const ANTHROPIC_MAX_TOKENS: u32 = 8_192;

/// Which wire protocol a runtime speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// The default: any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama,
    /// LM Studio, vLLM, …).
    OpenAiCompatible,
    /// Anthropic's native API (`/v1/messages`).
    Anthropic,
    /// Google's native Gemini API (`…/v1beta/models/{model}:generateContent`).
    Google,
}

/// Resolve the provider for a runtime: an explicit config value wins; otherwise
/// detect from the base URL host. Unknown/absent → OpenAI-compatible (today's
/// behavior, so existing configs are untouched).
///
/// One subtlety: Google also serves an **OpenAI-compatible** surface under
/// `…googleapis.com/**/openai`. A base URL that opts into that path keeps the
/// OpenAI protocol even on the Google host.
pub fn resolve_provider(explicit: Option<&str>, base_url: &str) -> Provider {
    match explicit.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("anthropic") => return Provider::Anthropic,
        Some("google") | Some("gemini") => return Provider::Google,
        Some("openai") | Some("openai-compatible") => return Provider::OpenAiCompatible,
        _ => {}
    }
    let host = crate::tools::policy::host_of(base_url).unwrap_or_default();
    if host.ends_with("anthropic.com") {
        Provider::Anthropic
    } else if host.ends_with("googleapis.com") {
        if base_url.trim_end_matches('/').ends_with("/openai")
            || base_url.contains("/openai/")
        {
            Provider::OpenAiCompatible
        } else {
            Provider::Google
        }
    } else {
        Provider::OpenAiCompatible
    }
}

/// Normalize a Google base URL to its `…/v1beta` root, whether the user pasted
/// the bare host or included the version segment.
fn google_root(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1beta") || base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{base}/v1beta")
    }
}

/// Gemini's chat URL — the model lives in the PATH, not the body, and streaming
/// is a different method (`:streamGenerateContent?alt=sse`).
pub fn google_chat_url(base_url: &str, model: &str, stream: bool) -> String {
    let root = google_root(base_url);
    let model = model.strip_prefix("models/").unwrap_or(model);
    if stream {
        format!("{root}/models/{model}:streamGenerateContent?alt=sse")
    } else {
        format!("{root}/models/{model}:generateContent")
    }
}

/// The chat-completion URL for a provider whose model travels in the request
/// BODY (OpenAI-compatible, Anthropic). Google's model lives in the URL path —
/// callers must use [`google_chat_url`] for [`Provider::Google`]; this returns
/// the Google root only as a harmless fallback.
pub fn chat_url(provider: Provider, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match provider {
        Provider::OpenAiCompatible => format!("{base}/chat/completions"),
        Provider::Anthropic => {
            if base.ends_with("/v1") {
                format!("{base}/messages")
            } else {
                format!("{base}/v1/messages")
            }
        }
        Provider::Google => google_root(base_url),
    }
}

/// The model-listing URL (also the health probe). Anthropic exposes
/// `GET /v1/models` with the OpenAI shape (`{data:[{id}]}`); Google exposes
/// `GET /v1beta/models` with `{models:[{name}]}` (parse via
/// [`parse_google_models`]).
pub fn models_url(provider: Provider, base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match provider {
        Provider::OpenAiCompatible => format!("{base}/models"),
        Provider::Anthropic => {
            if base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            }
        }
        Provider::Google => format!("{}/models", google_root(base_url)),
    }
}

/// The auth headers for a provider as (name, value) pairs. OpenAI-compatible
/// uses `Authorization: Bearer`; Anthropic uses `x-api-key` + a version header;
/// Google uses `x-goog-api-key`.
pub fn auth_headers(provider: Provider, api_key: &str) -> Vec<(&'static str, String)> {
    if api_key.is_empty() {
        // Anthropic still needs the version header even for (invalid) keyless
        // probes so the error is a clean 401, not a 400 protocol error.
        return match provider {
            Provider::Anthropic => {
                vec![("anthropic-version", ANTHROPIC_VERSION.to_string())]
            }
            Provider::OpenAiCompatible | Provider::Google => Vec::new(),
        };
    }
    match provider {
        Provider::OpenAiCompatible => {
            vec![("Authorization", format!("Bearer {api_key}"))]
        }
        Provider::Anthropic => vec![
            ("x-api-key", api_key.to_string()),
            ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ],
        Provider::Google => vec![("x-goog-api-key", api_key.to_string())],
    }
}

/// Extract the human part of a provider error body. Handles the common wire
/// shapes — OpenAI/OpenRouter/Gemini `{"error":{"message":…}}`, Anthropic
/// `{"type":"error","error":{"message":…}}`, Cohere `{"message":…}`, plain
/// `{"detail":…}` — and falls back to a trimmed excerpt of the raw body so the
/// user always sees what the provider actually said.
pub fn provider_error_message(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        for candidate in [&v["error"]["message"], &v["error"], &v["message"], &v["detail"]] {
            if let Some(s) = candidate.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    let trimmed = body.trim();
    let mut out: String = trimmed.chars().take(300).collect();
    if trimmed.chars().count() > 300 {
        out.push('…');
    }
    out
}

/// Split a `data:<media>;base64,<data>` URL into (media_type, data) for
/// Anthropic's image source blocks. `None` when it isn't a data URL.
fn split_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (media, data) = rest.split_once(";base64,")?;
    Some((media.to_string(), data.to_string()))
}

/// Convert one OpenAI-shaped message's content into Anthropic content blocks.
fn content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::String(s) => {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![json!({"type":"text","text": s})]
            }
        }
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p["type"].as_str() {
                Some("text") => Some(json!({"type":"text","text": p["text"]})),
                Some("image_url") => {
                    let url = p["image_url"]["url"].as_str()?;
                    let (media, data) = split_data_url(url)?;
                    Some(json!({
                        "type":"image",
                        "source": {"type":"base64","media_type": media,"data": data}
                    }))
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Build an Anthropic `/v1/messages` request from OpenAI-shaped messages.
///
/// Handles the full translation:
/// - `system` messages hoist into the top-level `system` string;
/// - text / image-parts content becomes Anthropic content blocks;
/// - an assistant message carrying OpenAI `tool_calls` becomes `tool_use` blocks;
/// - a `tool` result message becomes a user message with a `tool_result` block;
/// - OpenAI `tools` defs become Anthropic `{name, description, input_schema}`.
pub fn anthropic_request(
    model: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
    stream: bool,
    temperature: Option<f32>,
    top_p: Option<f32>,
) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();

    for m in messages {
        let role = m["role"].as_str().unwrap_or("user");
        match role {
            "system" => {
                if let Some(s) = m["content"].as_str() {
                    if !s.is_empty() {
                        system_parts.push(s.to_string());
                    }
                }
            }
            "assistant" => {
                let mut blocks = content_blocks(&m["content"]);
                if let Some(calls) = m["tool_calls"].as_array() {
                    for c in calls {
                        let args: Value = c["function"]["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or_else(|| json!({}));
                        blocks.push(json!({
                            "type":"tool_use",
                            "id": c["id"],
                            "name": c["function"]["name"],
                            "input": args
                        }));
                    }
                }
                if !blocks.is_empty() {
                    out.push(json!({"role":"assistant","content": blocks}));
                }
            }
            "tool" => {
                // OpenAI tool results map to a user message with a tool_result
                // block, referencing the tool_use id.
                out.push(json!({
                    "role":"user",
                    "content":[{
                        "type":"tool_result",
                        "tool_use_id": m["tool_call_id"],
                        "content": m["content"]
                    }]
                }));
            }
            _ => {
                let blocks = content_blocks(&m["content"]);
                if !blocks.is_empty() {
                    out.push(json!({"role":"user","content": blocks}));
                }
            }
        }
    }

    let mut req = json!({
        "model": model,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "messages": out,
        "stream": stream,
    });
    if !system_parts.is_empty() {
        req["system"] = json!(system_parts.join("\n\n"));
    }
    if let Some(t) = temperature {
        req["temperature"] = json!(t);
    }
    if let Some(p) = top_p {
        req["top_p"] = json!(p);
    }
    if let Some(tools) = tools {
        let mapped: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "input_schema": t["function"]["parameters"],
                })
            })
            .collect();
        if !mapped.is_empty() {
            req["tools"] = json!(mapped);
        }
    }
    req
}

/// One parsed assistant turn from a non-streamed Anthropic response, in AKA's
/// provider-neutral shape (mirrors `llm::AssistantTurn`'s fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTurn {
    pub content: Option<String>,
    /// (id, name, arguments-json) triples for each `tool_use` block.
    pub tool_calls: Vec<(String, String, String)>,
    pub reasoning: Option<String>,
}

/// Parse a non-streamed Anthropic `/v1/messages` response: text blocks join into
/// `content`, `tool_use` blocks become tool calls, `thinking` blocks (extended
/// thinking) become `reasoning`.
pub fn parse_anthropic_response(body: &Value) -> ParsedTurn {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<(String, String, String)> = Vec::new();

    if let Some(blocks) = body["content"].as_array() {
        for b in blocks {
            match b["type"].as_str() {
                Some("text") => {
                    if let Some(t) = b["text"].as_str() {
                        text.push_str(t);
                    }
                }
                Some("thinking") => {
                    if let Some(t) = b["thinking"].as_str() {
                        reasoning.push_str(t);
                    }
                }
                Some("tool_use") => {
                    let id = b["id"].as_str().unwrap_or_default().to_string();
                    let name = b["name"].as_str().unwrap_or_default().to_string();
                    let args = serde_json::to_string(&b["input"]).unwrap_or_else(|_| "{}".into());
                    tool_calls.push((id, name, args));
                }
                _ => {}
            }
        }
    }

    ParsedTurn {
        content: if text.is_empty() { None } else { Some(text) },
        tool_calls,
        reasoning: if reasoning.is_empty() { None } else { Some(reasoning) },
    }
}

/// A streaming delta in AKA's neutral shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDelta {
    Text(String),
    Thinking(String),
}

/// Parse one Anthropic SSE `data:` payload into a delta. Anthropic streams
/// `content_block_delta` events whose delta is `text_delta` (answer) or
/// `thinking_delta` (extended thinking). Everything else (message_start,
/// content_block_start, ping, message_stop, …) yields `None`.
pub fn parse_anthropic_sse(data: &Value) -> Option<StreamDelta> {
    if data["type"].as_str() != Some("content_block_delta") {
        return None;
    }
    let delta = &data["delta"];
    match delta["type"].as_str() {
        Some("text_delta") => delta["text"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(|t| StreamDelta::Text(t.to_string())),
        Some("thinking_delta") => delta["thinking"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(|t| StreamDelta::Thinking(t.to_string())),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Google Gemini (native API)
// ---------------------------------------------------------------------------

/// Convert one OpenAI-shaped message's content into Gemini `parts`.
fn google_parts(content: &Value) -> Vec<Value> {
    match content {
        Value::String(s) => {
            if s.is_empty() {
                Vec::new()
            } else {
                vec![json!({"text": s})]
            }
        }
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| match p["type"].as_str() {
                Some("text") => Some(json!({"text": p["text"]})),
                Some("image_url") => {
                    let url = p["image_url"]["url"].as_str()?;
                    let (media, data) = split_data_url(url)?;
                    Some(json!({"inline_data": {"mime_type": media, "data": data}}))
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Build a Gemini `generateContent` request from OpenAI-shaped messages. The
/// model is NOT in the body (it lives in the URL — see [`google_chat_url`]).
///
/// Translation:
/// - `system` messages hoist into `system_instruction`;
/// - `assistant` becomes role `model`; its OpenAI `tool_calls` become
///   `functionCall` parts;
/// - a `tool` result message becomes a user `functionResponse` part — Gemini
///   keys these by function NAME, so the name is recovered from the preceding
///   assistant turn's `tool_calls` via its `tool_call_id`;
/// - OpenAI `tools` defs become one `{functionDeclarations:[…]}` entry.
pub fn google_request(
    messages: &[Value],
    tools: Option<&[Value]>,
    temperature: Option<f32>,
    top_p: Option<f32>,
) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut contents: Vec<Value> = Vec::new();
    // tool_call_id → function name, harvested from assistant turns so tool
    // results can be keyed by name the way Gemini requires.
    let mut call_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for m in messages {
        let role = m["role"].as_str().unwrap_or("user");
        match role {
            "system" => {
                if let Some(s) = m["content"].as_str() {
                    if !s.is_empty() {
                        system_parts.push(s.to_string());
                    }
                }
            }
            "assistant" => {
                let mut parts = google_parts(&m["content"]);
                if let Some(calls) = m["tool_calls"].as_array() {
                    for c in calls {
                        let name = c["function"]["name"].as_str().unwrap_or_default();
                        if let Some(id) = c["id"].as_str() {
                            call_names.insert(id.to_string(), name.to_string());
                        }
                        let args: Value = c["function"]["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or_else(|| json!({}));
                        parts.push(json!({"functionCall": {"name": name, "args": args}}));
                    }
                }
                if !parts.is_empty() {
                    contents.push(json!({"role": "model", "parts": parts}));
                }
            }
            "tool" => {
                let id = m["tool_call_id"].as_str().unwrap_or_default();
                let name = call_names.get(id).cloned().unwrap_or_else(|| id.to_string());
                contents.push(json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": name,
                            "response": {"result": m["content"]}
                        }
                    }]
                }));
            }
            _ => {
                let parts = google_parts(&m["content"]);
                if !parts.is_empty() {
                    contents.push(json!({"role": "user", "parts": parts}));
                }
            }
        }
    }

    let mut req = json!({"contents": contents});
    if !system_parts.is_empty() {
        req["system_instruction"] = json!({"parts": [{"text": system_parts.join("\n\n")}]});
    }
    let mut gen: serde_json::Map<String, Value> = serde_json::Map::new();
    if let Some(t) = temperature {
        gen.insert("temperature".into(), json!(t));
    }
    if let Some(p) = top_p {
        gen.insert("topP".into(), json!(p));
    }
    if !gen.is_empty() {
        req["generationConfig"] = Value::Object(gen);
    }
    if let Some(tools) = tools {
        let decls: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t["function"]["name"],
                    "description": t["function"]["description"],
                    "parameters": t["function"]["parameters"],
                })
            })
            .collect();
        if !decls.is_empty() {
            req["tools"] = json!([{"functionDeclarations": decls}]);
        }
    }
    req
}

/// Parse a non-streamed Gemini response: text parts join into `content`
/// (`thought: true` parts go to `reasoning`), `functionCall` parts become tool
/// calls. Gemini doesn't issue call ids, so stable synthetic ids (`g-0`, `g-1`,
/// …) are minted — [`google_request`] recovers names from the assistant turn,
/// so the ids only need to be unique within it.
pub fn parse_google_response(body: &Value) -> ParsedTurn {
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<(String, String, String)> = Vec::new();

    if let Some(parts) = body["candidates"][0]["content"]["parts"].as_array() {
        for p in parts {
            if let Some(t) = p["text"].as_str() {
                if p["thought"].as_bool() == Some(true) {
                    reasoning.push_str(t);
                } else {
                    text.push_str(t);
                }
            }
            if p["functionCall"].is_object() {
                let name = p["functionCall"]["name"].as_str().unwrap_or_default().to_string();
                let args =
                    serde_json::to_string(&p["functionCall"]["args"]).unwrap_or_else(|_| "{}".into());
                let id = format!("g-{}", tool_calls.len());
                tool_calls.push((id, name, args));
            }
        }
    }

    ParsedTurn {
        content: if text.is_empty() { None } else { Some(text) },
        tool_calls,
        reasoning: if reasoning.is_empty() { None } else { Some(reasoning) },
    }
}

/// Parse one Gemini SSE `data:` payload (each is a whole GenerateContentResponse
/// chunk). Text parts stream as [`StreamDelta::Text`]; `thought: true` parts as
/// [`StreamDelta::Thinking`]. Multiple parts in one chunk are concatenated per
/// kind; a chunk with neither yields `None`.
pub fn parse_google_sse(data: &Value) -> Option<StreamDelta> {
    let parts = data["candidates"][0]["content"]["parts"].as_array()?;
    let mut text = String::new();
    let mut thinking = String::new();
    for p in parts {
        if let Some(t) = p["text"].as_str() {
            if p["thought"].as_bool() == Some(true) {
                thinking.push_str(t);
            } else {
                text.push_str(t);
            }
        }
    }
    if !text.is_empty() {
        Some(StreamDelta::Text(text))
    } else if !thinking.is_empty() {
        Some(StreamDelta::Thinking(thinking))
    } else {
        None
    }
}

/// Parse Gemini's `GET /v1beta/models` response (`{models:[{name:"models/…"}]}`)
/// into bare model ids, keeping only models that can actually generate content
/// when the capability list is present.
pub fn parse_google_models(body: &Value) -> Vec<String> {
    body["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter(|m| {
                    m["supportedGenerationMethods"]
                        .as_array()
                        .map(|methods| {
                            methods.iter().any(|x| {
                                x.as_str()
                                    .is_some_and(|s| s.contains("generateContent"))
                            })
                        })
                        .unwrap_or(true)
                })
                .filter_map(|m| m["name"].as_str())
                .map(|n| n.strip_prefix("models/").unwrap_or(n).to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_error_message_handles_common_shapes() {
        // OpenAI / OpenRouter / Gemini
        assert_eq!(
            provider_error_message(r#"{"error":{"message":"invalid message provided at index 4"}}"#),
            "invalid message provided at index 4"
        );
        // Anthropic
        assert_eq!(
            provider_error_message(r#"{"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}"#),
            "messages: text content blocks must be non-empty"
        );
        // Cohere-style top-level message
        assert_eq!(
            provider_error_message(r#"{"message":"invalid request"}"#),
            "invalid request"
        );
        // Plain string `error`
        assert_eq!(provider_error_message(r#"{"error":"model not found"}"#), "model not found");
        // Non-JSON falls back to the raw body
        assert_eq!(provider_error_message("  upstream timeout  "), "upstream timeout");
    }


    #[test]
    fn google_provider_resolution_and_urls() {
        // Host detection → Google; the OpenAI-compat path on the same host stays OpenAI.
        assert_eq!(
            resolve_provider(None, "https://generativelanguage.googleapis.com"),
            Provider::Google
        );
        assert_eq!(
            resolve_provider(None, "https://generativelanguage.googleapis.com/v1beta/openai"),
            Provider::OpenAiCompatible
        );
        assert_eq!(resolve_provider(Some("gemini"), "http://x"), Provider::Google);
        // URLs: model in the path; stream = a different method + alt=sse.
        assert_eq!(
            google_chat_url("https://generativelanguage.googleapis.com", "gemini-2.0-flash", false),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
        );
        assert_eq!(
            google_chat_url("https://generativelanguage.googleapis.com/v1beta", "models/gemini-2.0-flash", true),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            models_url(Provider::Google, "https://generativelanguage.googleapis.com"),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
        assert_eq!(
            auth_headers(Provider::Google, "AIza-x"),
            vec![("x-goog-api-key", "AIza-x".to_string())]
        );
    }

    #[test]
    fn google_request_maps_system_tools_and_results_by_name() {
        let messages = vec![
            json!({"role":"system","content":"be brief"}),
            json!({"role":"user","content":"hi"}),
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"g-0","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.ts\"}"}}
            ]}),
            json!({"role":"tool","tool_call_id":"g-0","content":"file body"}),
        ];
        let tools = vec![json!({
            "type":"function",
            "function":{"name":"read_file","description":"Read.","parameters":{"type":"object"}}
        })];
        let req = google_request(&messages, Some(&tools), Some(0.2), None);

        assert_eq!(req["system_instruction"]["parts"][0]["text"], "be brief");
        let contents = req["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["functionCall"]["name"], "read_file");
        assert_eq!(contents[1]["parts"][0]["functionCall"]["args"]["path"], "a.ts");
        // The tool result is keyed by NAME, recovered from the id via the
        // preceding assistant turn.
        assert_eq!(contents[2]["parts"][0]["functionResponse"]["name"], "read_file");
        assert_eq!(req["tools"][0]["functionDeclarations"][0]["name"], "read_file");
        // f32 → JSON widens to f64 (0.2f32 ≈ 0.20000000298…), so compare loosely.
        let temp = req["generationConfig"]["temperature"].as_f64().unwrap();
        assert!((temp - 0.2).abs() < 1e-6);
    }

    #[test]
    fn google_request_maps_image_parts() {
        let messages = vec![json!({"role":"user","content":[
            {"type":"text","text":"what is this?"},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}
        ]})];
        let req = google_request(&messages, None, None, None);
        let parts = req["contents"][0]["parts"].as_array().unwrap();
        assert_eq!(parts[0]["text"], "what is this?");
        assert_eq!(parts[1]["inline_data"]["mime_type"], "image/png");
        assert_eq!(parts[1]["inline_data"]["data"], "QUJD");
    }

    #[test]
    fn parses_google_response_and_sse() {
        let body = json!({"candidates":[{"content":{"parts":[
            {"text":"hmm","thought":true},
            {"text":"Answer."},
            {"functionCall":{"name":"list_dir","args":{"path":"src"}}}
        ]}}]});
        let turn = parse_google_response(&body);
        assert_eq!(turn.content.as_deref(), Some("Answer."));
        assert_eq!(turn.reasoning.as_deref(), Some("hmm"));
        let (id, name, args) = &turn.tool_calls[0];
        assert_eq!((id.as_str(), name.as_str()), ("g-0", "list_dir"));
        assert_eq!(serde_json::from_str::<Value>(args).unwrap()["path"], "src");

        // SSE chunks are whole responses; thought parts stream as Thinking.
        let chunk = json!({"candidates":[{"content":{"parts":[{"text":"He"}]}}]});
        assert_eq!(parse_google_sse(&chunk), Some(StreamDelta::Text("He".into())));
        let think = json!({"candidates":[{"content":{"parts":[{"text":"…","thought":true}]}}]});
        assert_eq!(parse_google_sse(&think), Some(StreamDelta::Thinking("…".into())));
        assert_eq!(parse_google_sse(&json!({"usageMetadata":{}})), None);
    }

    #[test]
    fn parses_google_models_list() {
        let body = json!({"models":[
            {"name":"models/gemini-2.0-flash","supportedGenerationMethods":["generateContent"]},
            {"name":"models/embedding-001","supportedGenerationMethods":["embedContent"]},
            {"name":"models/gemini-2.5-pro"}
        ]});
        assert_eq!(
            parse_google_models(&body),
            vec!["gemini-2.0-flash".to_string(), "gemini-2.5-pro".to_string()]
        );
    }

    #[test]
    fn provider_resolution_is_explicit_first_then_host() {
        // Explicit config wins over the URL.
        assert_eq!(
            resolve_provider(Some("anthropic"), "http://localhost:9999/v1"),
            Provider::Anthropic
        );
        assert_eq!(
            resolve_provider(Some("openai"), "https://api.anthropic.com"),
            Provider::OpenAiCompatible
        );
        // No explicit value → detect from the host.
        assert_eq!(
            resolve_provider(None, "https://api.anthropic.com"),
            Provider::Anthropic
        );
        // Everything else stays OpenAI-compatible (existing configs untouched).
        assert_eq!(
            resolve_provider(None, "https://openrouter.ai/api/v1"),
            Provider::OpenAiCompatible
        );
        assert_eq!(
            resolve_provider(None, "http://localhost:11434/v1"),
            Provider::OpenAiCompatible
        );
    }

    #[test]
    fn urls_handle_v1_suffix_both_ways() {
        assert_eq!(
            chat_url(Provider::Anthropic, "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            chat_url(Provider::Anthropic, "https://api.anthropic.com/v1/"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            models_url(Provider::Anthropic, "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            chat_url(Provider::OpenAiCompatible, "http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn auth_headers_differ_per_provider() {
        assert_eq!(
            auth_headers(Provider::OpenAiCompatible, "sk-x"),
            vec![("Authorization", "Bearer sk-x".to_string())]
        );
        let anth = auth_headers(Provider::Anthropic, "sk-ant-x");
        assert!(anth.contains(&("x-api-key", "sk-ant-x".to_string())));
        assert!(anth.contains(&("anthropic-version", ANTHROPIC_VERSION.to_string())));
    }

    #[test]
    fn anthropic_request_hoists_system_and_maps_tools() {
        let messages = vec![
            json!({"role":"system","content":"be brief"}),
            json!({"role":"user","content":"hi"}),
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"t1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.ts\"}"}}
            ]}),
            json!({"role":"tool","tool_call_id":"t1","content":"file body"}),
        ];
        let tools = vec![json!({
            "type":"function",
            "function":{"name":"read_file","description":"Read.","parameters":{"type":"object"}}
        })];
        let req = anthropic_request("claude-x", &messages, Some(&tools), false, Some(0.2), None);

        assert_eq!(req["system"], "be brief");
        assert_eq!(req["model"], "claude-x");
        assert_eq!(req["max_tokens"], ANTHROPIC_MAX_TOKENS);
        // No system message leaked into messages; roles map user/assistant/user.
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][0]["input"]["path"], "a.ts");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "t1");
        // Tool defs use input_schema, not parameters.
        assert_eq!(req["tools"][0]["name"], "read_file");
        assert!(req["tools"][0]["input_schema"].is_object());
    }

    #[test]
    fn anthropic_request_maps_image_parts() {
        let messages = vec![json!({"role":"user","content":[
            {"type":"text","text":"what is this?"},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}
        ]})];
        let req = anthropic_request("claude-x", &messages, None, false, None, None);
        let blocks = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["source"]["media_type"], "image/png");
        assert_eq!(blocks[1]["source"]["data"], "QUJD");
    }

    #[test]
    fn parses_anthropic_response_blocks() {
        let body = json!({"content":[
            {"type":"thinking","thinking":"hmm"},
            {"type":"text","text":"Answer."},
            {"type":"tool_use","id":"t9","name":"list_dir","input":{"path":"src"}}
        ]});
        let turn = parse_anthropic_response(&body);
        assert_eq!(turn.content.as_deref(), Some("Answer."));
        assert_eq!(turn.reasoning.as_deref(), Some("hmm"));
        assert_eq!(turn.tool_calls.len(), 1);
        let (id, name, args) = &turn.tool_calls[0];
        assert_eq!((id.as_str(), name.as_str()), ("t9", "list_dir"));
        assert_eq!(serde_json::from_str::<Value>(args).unwrap()["path"], "src");
    }

    #[test]
    fn parses_anthropic_stream_deltas() {
        let text = json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}});
        assert_eq!(parse_anthropic_sse(&text), Some(StreamDelta::Text("He".into())));
        let think = json!({"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}});
        assert_eq!(
            parse_anthropic_sse(&think),
            Some(StreamDelta::Thinking("…".into()))
        );
        // Non-delta events are ignored.
        for t in ["message_start", "content_block_start", "ping", "message_stop"] {
            assert_eq!(parse_anthropic_sse(&json!({"type": t})), None);
        }
    }
}
