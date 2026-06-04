import { create } from "zustand";
import {
  countTokens,
  getContextLimit,
  getMemoryUsage,
  type ChatMessage,
} from "../lib/tauri/commands";
import { useMessagesStore, type Message } from "./use-messages-store";
import {
  builtinEndpoint,
  useRuntimeStore,
} from "../features/01-llm-provider/use-runtime-store";

// Tracks the live token count of the current session against the active
// model's context window. Recomputes after every session message append and
// on every model swap; resets to 0 when the session clears. Both the count
// and the limit are estimates — `used` should always be rendered with a "~"
// prefix in the UI.

export type TokenStatus = "ok" | "warn" | "danger" | "over";

type TokenCounterState = {
  used: number;
  limit: number;
  /** Used / limit as a fraction (0–1+). */
  ratio: number;
  status: TokenStatus;
  /** Set true once the 90% toast has fired for the current session/model. */
  warned: boolean;

  refresh: () => Promise<void>;
  reset: () => void;
};

function classify(ratio: number): TokenStatus {
  if (ratio >= 1) return "over";
  if (ratio >= 0.9) return "danger";
  if (ratio >= 0.7) return "warn";
  return "ok";
}

// The context limit only changes on a model/runtime swap, but `refresh()` runs
// on every message change (frequently, during streaming). Cache the resolved
// limit keyed by model + runtime so the hot path never re-hits the runtime's
// /metrics; recompute only when the key changes.
let cachedLimitKey = "";
let cachedLimit = 0;

function toChatMessage(m: Message): ChatMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") return { role: "assistant", content: m.content };
  // Tool messages carry the file path + diff stats. Encode them as
  // assistant-side context so they contribute to the token estimate.
  const path = m.toolPath ?? "";
  const kind = m.toolKind ?? "tool";
  return { role: "assistant", content: `[${kind}] ${path}`.trim() };
}

export const useTokenCounterStore = create<TokenCounterState>((set, get) => ({
  used: 0,
  limit: 32_768,
  ratio: 0,
  status: "ok",
  warned: false,

  refresh: async () => {
    try {
      const messages = useMessagesStore.getState().messages;
      const rt = useRuntimeStore.getState();
      const modelId = rt.selectedModelId ?? "";

      // For the built-in runtime, the real limit is the sidecar's allocated
      // context window (from /metrics), not the model family's trained max.
      // Fall back to the static family lookup for external runtimes or if the
      // metric is unavailable. Cached per model/runtime so streaming (same key)
      // never re-hits /metrics.
      const builtinActive =
        rt.builtinPort != null &&
        rt.active?.baseUrl === builtinEndpoint(rt.builtinPort);
      const limitKey = `${modelId}|${builtinActive ? (rt.active?.baseUrl ?? "") : ""}`;
      let limit: number;
      if (limitKey === cachedLimitKey && cachedLimit > 0) {
        limit = cachedLimit;
      } else {
        limit = await getContextLimit(modelId);
        if (builtinActive && rt.active) {
          const mem = await getMemoryUsage(rt.active.baseUrl).catch(() => null);
          if (mem?.ctxSize && mem.ctxSize > 0) limit = mem.ctxSize;
        }
        cachedLimitKey = limitKey;
        cachedLimit = limit;
      }

      const used =
        messages.length === 0
          ? 0
          : await countTokens(messages.map(toChatMessage));

      const ratio = limit > 0 ? used / limit : 0;
      const status = classify(ratio);

      const prev = get();
      const crossed90 =
        !prev.warned && status !== "ok" && status !== "warn" && ratio >= 0.9;

      set({
        used,
        limit,
        ratio,
        status,
        warned: prev.warned || crossed90,
      });

      if (crossed90) {
        useRuntimeStore.getState().pushToast({
          kind: "info",
          text: "Approaching context limit. Consider starting a new session or the summary may be cut off.",
        });
      }
    } catch (err) {
      // Token-counter failures are non-fatal — leave the previous reading in
      // place and log. An unhandled rejection here during a swap can blank
      // the WebView.
      // eslint-disable-next-line no-console
      console.warn("[token-counter] refresh failed:", err);
    }
  },

  reset: () => set({ used: 0, ratio: 0, status: "ok", warned: false }),
}));
