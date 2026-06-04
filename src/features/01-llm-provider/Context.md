# llm-provider

## Status
Agnostic OpenAI-compatible runtime connection layer wired end-to-end.

## What it does
- Probes localhost ports for known OpenAI-compatible runtimes (Ollama, LM Studio,
  llama.cpp) at startup and on demand.
- Lets the user pick a detected runtime or enter a custom `base_url` + optional
  API key (validated against `/v1/models` before saving).
- Persists the active `RuntimeConfig` in the app's global `.äkä/config.json`.
- Lists available models from the selected runtime via `/v1/models` and exposes
  them through `ModelPicker`.
- Re-probes runtime health every 30s; on transition to unhealthy, surfaces a
  toast and disables the send button via `useRuntimeStore`.
- Single inference entrypoint: `callLlm(messages, model?)` hits the active
  runtime's `/v1/chat/completions`.

## Files
- `use-runtime-store.ts` — Zustand store, bootstrap + health polling.
- `ConnectionPanel.tsx` — detection list, manual entry, health dots.
- `RuntimeToasts.tsx` — disconnect toast surface.

## Constraints
- "Ollama" appears only in the default URL string and the detection probe list
  (Rust + TS). Nowhere else in logic.
- All LLM calls funnel through `callLlm`.
