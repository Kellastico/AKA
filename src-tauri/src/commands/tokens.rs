use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// Rough token estimate: serialize the message array to JSON and divide the
/// character count by 4. This is an **approximation**, not a tokenizer — it
/// trends close enough for sizing the context bar but should never be shown
/// to the user without a "~" qualifier.
#[tauri::command]
pub fn count_tokens(messages: Vec<Message>) -> Result<u32, String> {
    let serialized = serde_json::to_string(&messages).map_err(|e| e.to_string())?;
    Ok((serialized.chars().count() / 4) as u32)
}

// ── Memory usage ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUsage {
    /// AKA desktop-app process resident set size in MB.
    pub app_mb: f64,
    /// Loaded-model footprint in MB. For the built-in runtime this is the GGUF
    /// size from `/metrics` (a close proxy for unified-memory use on Apple
    /// Silicon, where weights are mmap'd / held in Metal buffers and so under-
    /// report as process RSS); for Ollama it's the sum from `/api/ps`. Zero when
    /// unavailable.
    pub model_mb: f64,
    /// Total AKA memory footprint: `app_mb + model_mb`.
    pub total_mb: f64,
    /// The built-in runtime's allocated context window (tokens), from
    /// `/metrics`. `None` for external runtimes.
    pub ctx_size: Option<u32>,
    /// Decode throughput of the built-in runtime's last generation (tokens/sec),
    /// from `/metrics`. `None` for external runtimes or before any generation.
    pub last_tokens_per_sec: Option<f64>,
}

/// Shape of the ÄKÄ sidecar's `/metrics` endpoint (subset we consume).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarMetrics {
    model_mb: f64,
    ctx_size: u32,
    last_tokens_per_sec: f64,
}

/// Return AKA's memory picture for the Context Window panel. Always includes the
/// desktop app's RSS; then, depending on the active runtime:
///   - ÄKÄ built-in → queries the sidecar `/metrics` for the real model
///     footprint, sidecar RSS, context size and last tokens/sec.
///   - Ollama       → sums loaded-model size from `/api/ps`.
/// All runtime queries are best-effort — failures leave the relevant fields at
/// zero / `None` rather than erroring.
#[tauri::command]
pub async fn get_memory_usage(runtime_base_url: Option<String>) -> MemoryUsage {
    let app_mb = process_rss_mb().await;

    // Try the built-in runtime's /metrics first (it answers only for ÄKÄ).
    if let Some(url) = runtime_base_url.as_deref() {
        if let Some(m) = aka_sidecar_metrics(url).await {
            return MemoryUsage {
                app_mb,
                model_mb: m.model_mb,
                total_mb: app_mb + m.model_mb,
                ctx_size: Some(m.ctx_size),
                last_tokens_per_sec: Some(m.last_tokens_per_sec),
            };
        }
    }

    // Otherwise fall back to the Ollama footprint (no separate sidecar process).
    let model_mb = match runtime_base_url {
        Some(url) => ollama_model_mb(&url).await,
        None => 0.0,
    };
    MemoryUsage {
        app_mb,
        model_mb,
        total_mb: app_mb + model_mb,
        ctx_size: None,
        last_tokens_per_sec: None,
    }
}

/// Query the ÄKÄ sidecar's `/metrics`. Returns `None` if the endpoint isn't the
/// built-in runtime (or is unreachable / returns an unexpected shape).
async fn aka_sidecar_metrics(base_url: &str) -> Option<SidecarMetrics> {
    // `/metrics` lives at the server root, not under the `/v1` OpenAI prefix.
    let root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/');
    let url = format!("{root}/metrics");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<SidecarMetrics>().await.ok()
}

/// AKA's own resident set size in MB, read via `ps -o rss= -p <pid>`.
/// `rss` is reported in KB on macOS and Linux.
async fn process_rss_mb() -> f64 {
    let pid = std::process::id();
    let Ok(out) = tokio::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .await
    else {
        return 0.0;
    };
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(0.0)
        / 1024.0 // KB → MB
}

/// Query Ollama's `/api/ps` and sum the `size` field across all loaded models.
/// `size` is the model footprint in bytes (RAM + VRAM combined).
/// Returns 0 if the endpoint is unreachable, not Ollama, or returns no models.
async fn ollama_model_mb(base_url: &str) -> f64 {
    // Strip the `/v1` OpenAI-compat suffix — Ollama's own API lives at root.
    let root = base_url
        .trim_end_matches('/')
        .trim_end_matches("/v1")
        .trim_end_matches('/');
    let url = format!("{}/api/ps", root);

    #[derive(Deserialize)]
    struct Model {
        size: u64,
    }
    #[derive(Deserialize)]
    struct PsResp {
        models: Vec<Model>,
    }

    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return 0.0;
    };

    let Ok(resp) = client.get(&url).send().await else {
        return 0.0;
    };
    if !resp.status().is_success() {
        return 0.0;
    }
    let Ok(ps) = resp.json::<PsResp>().await else {
        return 0.0;
    };

    ps.models.iter().map(|m| m.size as f64).sum::<f64>() / (1024.0 * 1024.0)
}

// ── Context window ───────────────────────────────────────────────────────────

/// Known context window for a runtime model id. The lookup is intentionally
/// substring-based: runtime ids like `llama3.1:70b-instruct-q4_K_M` should
/// still resolve to the family default. Unknown models fall back to 32k.
#[tauri::command]
pub fn get_context_limit(model: String) -> u32 {
    let m = model.to_lowercase();
    // Gemma family (gemma2, gemma3, gemma4, …) — all 128k
    if m.contains("gemma") {
        return 128_000;
    }
    // Llama 3.x family — all 128k
    if m.contains("llama3") || m.contains("llama-3") {
        return 128_000;
    }
    // DeepSeek R1/V3
    if m.contains("deepseek") {
        return 128_000;
    }
    // Phi-3.5 / Phi-4 — 128k; Phi-3 Mini — 4k. Treat unknown phi as 128k.
    if m.contains("phi-4") || m.contains("phi4") || m.contains("phi-3.5") {
        return 128_000;
    }
    if m.contains("phi-3") || m.contains("phi3") {
        return 4_096;
    }
    // Qwen 2.5 / 3
    if m.contains("qwen") {
        return 32_768;
    }
    // Mistral / Mixtral
    if m.contains("mistral") || m.contains("mixtral") {
        return 32_768;
    }
    // Default
    32_768
}
