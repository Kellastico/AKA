//! Real llama.cpp inference for the ÄKÄ runtime.
//!
//! Wraps `llama-cpp-2` (imported as `llama_cpp_2`). Holds a single loaded model
//! and runs generation synchronously — callers drive it from
//! `tokio::task::spawn_blocking` so the async runtime is never blocked.
//!
//! Concurrency model: `LlamaModel` is `Send + Sync`, so it lives behind an
//! `Arc<LoadedModel>` that a request clones out of `AppState` (releasing the
//! state lock immediately). A fresh `LlamaContext` — which borrows the model
//! and owns the KV cache — is created per request inside the blocking task and
//! dropped when generation ends. Contexts are never shared between requests.

use std::num::NonZeroU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

/// A fully loaded model held in memory, ready to serve inference.
///
/// `LlamaModel` is not `Clone`; this struct is shared via `Arc<LoadedModel>`
/// and the weights are freed when the last `Arc` is dropped (load/unload swaps
/// the `Option<Arc<LoadedModel>>` in `AppState`).
pub struct LoadedModel {
    /// The `.gguf` filename this was loaded from (matches the models-dir entry).
    pub filename: String,
    /// The loaded weights.
    pub model: LlamaModel,
    /// Context window (tokens) to allocate per request — from `--ctx-size`.
    pub ctx_size: u32,
    /// On-disk size of the `.gguf` in bytes — a close proxy for the in-RAM
    /// weight footprint, surfaced via `/metrics`.
    pub size_bytes: u64,
}


/// Load a GGUF model from disk. Blocking and CPU/GPU-heavy — call from
/// `spawn_blocking`. `gpu_layers` is the offload count passed by the launching
/// app (Metal uses a large sentinel for "all"; CPU-only is 0).
pub fn load_model(
    backend: &LlamaBackend,
    path: &std::path::Path,
    filename: String,
    gpu_layers: u32,
    ctx_size: u32,
) -> Result<LoadedModel, String> {
    use llama_cpp_2::model::params::LlamaModelParams;

    let params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
    let model = LlamaModel::load_from_file(backend, path, &params)
        .map_err(|e| format!("Failed to load model: {e}"))?;
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    Ok(LoadedModel {
        filename,
        model,
        ctx_size,
        size_bytes,
    })
}

/// Format conversation `messages` (each `(role, content)`) into the raw prompt
/// string the model expects. Prefers the model's embedded chat template; on any
/// failure (no template baked in, or application error) falls back to ChatML —
/// the most widely compatible format for coding models.
pub fn format_prompt(model: &LlamaModel, messages: &[(String, String)]) -> String {
    match apply_chat_template(model, messages) {
        Ok(prompt) => prompt,
        Err(e) => {
            tracing::warn!("chat template failed ({e}); falling back to ChatML");
            chatml_fallback(messages)
        }
    }
}

/// Apply the model's embedded chat template. `add_ass = true` appends the
/// assistant generation prompt so the model continues as the assistant.
fn apply_chat_template(model: &LlamaModel, messages: &[(String, String)]) -> Result<String, String> {
    let tmpl = model
        .chat_template(None)
        .map_err(|e| format!("no embedded template: {e}"))?;
    let chat: Vec<LlamaChatMessage> = messages
        .iter()
        .map(|(role, content)| LlamaChatMessage::new(role.clone(), content.clone()))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("invalid chat message: {e}"))?;
    model
        .apply_chat_template(&tmpl, &chat, true)
        .map_err(|e| format!("apply template: {e}"))
}

/// ChatML fallback used when the model has no embedded template.
fn chatml_fallback(messages: &[(String, String)]) -> String {
    let mut prompt = String::new();
    for (role, content) in messages {
        prompt.push_str(&format!("<|im_start|>{role}\n{content}<|im_end|>\n"));
    }
    prompt.push_str("<|im_start|>assistant\n");
    prompt
}

/// Knobs for a single generation. `temperature` and `max_tokens` come from the
/// chat request (with defaults applied by the caller); `threads` from `AppState`.
pub struct GenerateParams {
    pub prompt: String,
    pub temperature: f32,
    pub max_tokens: usize,
    pub threads: u32,
}

/// Run one full generation synchronously — call from `spawn_blocking`.
///
/// Creates a fresh per-request `LlamaContext` (KV cache), tokenises the prompt,
/// decodes the prefill, then samples token-by-token. `on_token(piece)` is
/// invoked for each decoded piece; returning `false` (client disconnected)
/// stops generation. `cancel` is checked before every token, so `POST /abort`
/// interrupts within one token. Returns `Ok` for every clean stop
/// (EOG / max_tokens / cancel / client-gone) and `Err` only on a real
/// inference failure.
///
/// Detokenisation uses `token_to_str` per token; a multi-byte UTF-8 codepoint
/// split across two tokens can render imperfectly. Acceptable for the common
/// (largely ASCII) coding case; a persistent streaming decoder can refine it
/// later.
///
/// Returns the decode throughput (generated tokens ÷ generation seconds),
/// `0.0` when nothing was generated.
#[allow(deprecated)] // `Special` is deprecated upstream but is the simple path
pub fn generate_blocking(
    backend: &LlamaBackend,
    loaded: &LoadedModel,
    params: GenerateParams,
    cancel: Arc<AtomicBool>,
    mut on_token: impl FnMut(String) -> bool,
) -> Result<f64, String> {
    let model = &loaded.model;

    // Per-request context owning this generation's KV cache.
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(loaded.ctx_size))
        .with_n_threads(params.threads as i32)
        .with_n_threads_batch(params.threads as i32);
    let mut ctx = model
        .new_context(backend, ctx_params)
        .map_err(|e| format!("Failed to create context: {e}"))?;

    // Tokenise and guard against prompts that don't fit the context window.
    let tokens = model
        .str_to_token(&params.prompt, AddBos::Always)
        .map_err(|e| format!("Tokenisation failed: {e}"))?;
    let n_prompt = tokens.len();
    if n_prompt == 0 {
        return Err("Prompt tokenised to zero tokens".to_string());
    }
    if n_prompt >= loaded.ctx_size as usize {
        return Err(format!(
            "Prompt is {n_prompt} tokens but the context window is {}. Reduce prompt length.",
            loaded.ctx_size
        ));
    }

    // Prefill: decode the whole prompt, requesting logits only for the last token.
    let mut batch = LlamaBatch::new(n_prompt, 1);
    let last = n_prompt - 1;
    for (i, tok) in tokens.iter().enumerate() {
        batch
            .add(*tok, i as i32, &[0], i == last)
            .map_err(|e| format!("batch add (prefill): {e}"))?;
    }
    ctx.decode(&mut batch)
        .map_err(|e| format!("Prefill decode failed: {e}"))?;

    // Sampler chain tuned for coding: filter the long tail, apply temperature,
    // then sample from the distribution with a fixed seed for reproducibility.
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::min_p(0.05, 1),
        LlamaSampler::temp(params.temperature),
        LlamaSampler::dist(1234),
    ]);

    let mut n_cur = n_prompt as i32; // absolute position of the next token
    let mut n_generated = 0usize;
    // Time the decode loop only — this is the "tokens/sec" users care about.
    let gen_start = std::time::Instant::now();

    loop {
        // Abort / budget checks before emitting each token.
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        if n_generated >= params.max_tokens {
            break;
        }

        // Sample from the logits produced by the most recent decode.
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        sampler.accept(token);

        if model.is_eog_token(token) {
            break;
        }

        let piece = model
            .token_to_str(token, llama_cpp_2::model::Special::Tokenize)
            .unwrap_or_default();
        if !on_token(piece) {
            break; // client disconnected
        }
        n_generated += 1;

        // Stop before overflowing the context window.
        if n_cur as u32 >= loaded.ctx_size {
            break;
        }

        // Feed the sampled token back in for the next step.
        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| format!("batch add (gen): {e}"))?;
        ctx.decode(&mut batch)
            .map_err(|e| format!("Decode failed at token {n_generated}: {e}"))?;
        n_cur += 1;
    }

    let elapsed = gen_start.elapsed().as_secs_f64();
    let tokens_per_sec = if elapsed > 0.0 && n_generated > 0 {
        n_generated as f64 / elapsed
    } else {
        0.0
    };
    Ok(tokens_per_sec)
}
