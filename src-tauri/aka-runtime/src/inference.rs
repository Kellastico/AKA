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
    /// Largest context this model was trained for. Going beyond it is allowed
    /// but degrades quality, so the UI warns rather than clamps.
    pub n_ctx_train: u32,
    /// Bytes of KV cache per token of context, for this model's architecture.
    ///
    /// The cache holds a key and a value vector per layer per token:
    /// `2 * n_layer * head_dim * n_head_kv * sizeof(f16)`. It scales exactly
    /// linearly with the context size, so this one constant lets the UI price
    /// any context window without re-deriving the architecture.
    pub kv_bytes_per_token: u64,
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
) -> Result<LoadedModel, String> {
    use llama_cpp_2::model::params::LlamaModelParams;

    let params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
    let model = LlamaModel::load_from_file(backend, path, &params)
        .map_err(|e| format!("Failed to load model: {e}"))?;
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    // Grouped-query attention means the KV heads can be fewer than the
    // attention heads, so the cache is sized on `n_head_kv`, not `n_head`.
    let head_dim = (model.n_embd() as u64) / (model.n_head() as u64).max(1);
    const KV_ELEM_BYTES: u64 = 2; // llama.cpp defaults both K and V to f16
    let kv_bytes_per_token =
        2 * model.n_layer() as u64 * head_dim * model.n_head_kv() as u64 * KV_ELEM_BYTES;
    let n_ctx_train = model.n_ctx_train();

    Ok(LoadedModel {
        filename,
        model,
        n_ctx_train,
        kv_bytes_per_token,
        size_bytes,
    })
}

/// Format conversation `messages` (each `(role, content)`) into the raw prompt
/// string the model expects. Prefers the model's embedded chat template; on any
/// failure (no template baked in, or application error) falls back to ChatML —
/// the most widely compatible format for coding models.
pub fn format_prompt(model: &LlamaModel, messages: &[(String, String)], reasoning: bool) -> String {
    let prompt = match apply_chat_template(model, messages) {
        Ok(prompt) => prompt,
        Err(e) => {
            tracing::warn!("chat template failed ({e}); falling back to ChatML");
            chatml_fallback(messages)
        }
    };
    if reasoning {
        prompt
    } else {
        suppress_reasoning(prompt)
    }
}

/// Close the reasoning block the template just opened, so the model emits an
/// empty one and answers directly.
///
/// Templates that support this expose it as a Jinja variable:
///
/// ```jinja
/// {%- if enable_thinking is defined and enable_thinking is false %}
///     {{- '<think>\n\n</think>\n\n' }}
/// {%- else %}
///     {{- '<think>\n' }}
/// {%- endif %}
/// ```
///
/// llama.cpp's template API takes messages and `add_ass` only — there is no way
/// to pass a custom variable through it — so the same result is produced by
/// completing the opened block. The output is byte-identical to what the
/// template emits on the `false` branch, which is why this is a faithful
/// implementation of the switch rather than an approximation of it.
///
/// A prompt that doesn't end in an open block is returned untouched: the model
/// has no reasoning step, and there is nothing to suppress.
fn suppress_reasoning(prompt: String) -> String {
    const OPEN: &str = "<think>\n";
    const CLOSE: &str = "\n</think>\n\n";
    if prompt.ends_with(OPEN) {
        format!("{prompt}{CLOSE}")
    } else {
        prompt
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
    /// Context window for this generation. Read fresh per request, so a change
    /// takes effect on the next message without reloading the weights.
    pub ctx_size: u32,
    /// Whether the model may reason before answering. Only meaningful for
    /// models whose chat template has an `enable_thinking` switch; ignored
    /// for every other model, which has no reasoning step to suppress.
    pub reasoning: bool,
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
        .with_n_ctx(NonZeroU32::new(params.ctx_size))
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
    if n_prompt >= params.ctx_size as usize {
        return Err(format!(
            "Prompt is {n_prompt} tokens but the context window is {}. Reduce prompt length.",
            params.ctx_size
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
        if n_cur as u32 >= params.ctx_size {
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

#[cfg(test)]
mod reasoning_tests {
    use super::suppress_reasoning;

    /// The exact bytes a supporting template emits on each branch:
    ///
    /// ```jinja
    /// {%- if enable_thinking is defined and enable_thinking is false %}
    ///     {{- '<think>\n\n</think>\n\n' }}
    /// {%- else %}
    ///     {{- '<think>\n' }}
    /// {%- endif %}
    /// ```
    const OPENED: &str = "<|im_start|>assistant\n<think>\n";
    const TEMPLATE_WOULD_EMIT: &str = "<|im_start|>assistant\n<think>\n\n</think>\n\n";

    #[test]
    fn matches_what_the_template_emits_when_thinking_is_disabled() {
        // Not an approximation of the switch — the identical string.
        assert_eq!(suppress_reasoning(OPENED.to_string()), TEMPLATE_WOULD_EMIT);
    }

    #[test]
    fn leaves_a_model_without_a_reasoning_step_alone() {
        // Qwen 2.5-Coder has no `enable_thinking` in its template, so its
        // prompt never ends with an open block and must pass through intact.
        let plain = "<|im_start|>assistant\n".to_string();
        assert_eq!(suppress_reasoning(plain.clone()), plain);
    }

    #[test]
    fn never_closes_a_block_that_is_already_closed() {
        let already = TEMPLATE_WOULD_EMIT.to_string();
        assert_eq!(suppress_reasoning(already.clone()), already);
    }

    #[test]
    fn does_not_touch_think_tags_inside_the_conversation() {
        // Prior turns carry their own <think>…</think>; only a block left open
        // at the very end is the generation prompt.
        let mid = "<|im_start|>assistant\n<think>\nprior\n</think>\n\nanswer".to_string();
        assert_eq!(suppress_reasoning(mid.clone()), mid);
    }
}
