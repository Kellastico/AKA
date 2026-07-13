import { create } from "zustand";
import { modelCapabilities } from "../lib/tauri/commands";
import type { ToolTransport } from "../lib/builtin-loop";

/**
 * Evidence about which tool transport a (runtime, model) pair actually
 * supports — the agnostic replacement for hardcoded model-ID heuristics.
 *
 * Two evidence sources, in trust order:
 *   1. **Observation** — a run succeeded natively, or the endpoint rejected the
 *      `tools` parameter and the loop fell back to text. Ground truth;
 *      overwrites anything advertised.
 *   2. **Advertisement** — the runtime self-reports per-model capabilities
 *      (Ollama's `/api/show`). Used to pick the starting transport and to
 *      show the reliability nudge *before* the first run.
 *
 * No entry means "unknown" — and unknown is handled optimistically by the
 * adaptive loop (try native, fall back on rejection), so a missing probe never
 * costs a model its tools. Session-scoped on purpose: a runtime update can
 * change a model's capabilities, so nothing is persisted to disk.
 */

/** Cache key: the pair that defines capability, not the model name alone. */
export const supportKey = (baseUrl: string, modelId: string): string =>
  `${baseUrl}::${modelId}`;

type ToolSupportState = {
  /** Best current evidence per supportKey. Absent = unknown. */
  known: Record<string, ToolTransport>;
  /** Keys whose runtime-advertisement probe already ran (even if it answered nothing). */
  probed: Record<string, boolean>;
  /**
   * Ask the runtime (once per key) whether the model advertises tools.
   * Best-effort and cheap (3s timeout host-side); silently does nothing for
   * runtimes that don't self-report. Never downgrades an observation.
   */
  ensureProbe: (baseUrl: string, modelId: string) => Promise<void>;
  /** Record what a run actually proved. Observation is ground truth. */
  observe: (baseUrl: string, modelId: string, transport: ToolTransport) => void;
};

export const useToolSupportStore = create<ToolSupportState>((set, get) => ({
  known: {},
  probed: {},

  ensureProbe: async (baseUrl, modelId) => {
    const key = supportKey(baseUrl, modelId);
    if (!baseUrl || !modelId || get().probed[key]) return;
    set((st) => ({ probed: { ...st.probed, [key]: true } }));
    try {
      const caps = await modelCapabilities(baseUrl, modelId);
      if (!caps) return; // runtime doesn't self-report — stay unknown
      const advertised: ToolTransport = caps.includes("tools") ? "native" : "text";
      set((st) =>
        // An observation may have landed while the probe was in flight — keep it.
        st.known[key] !== undefined ? {} : { known: { ...st.known, [key]: advertised } },
      );
    } catch {
      /* offline / non-Ollama — unknown is a fine answer */
    }
  },

  observe: (baseUrl, modelId, transport) => {
    const key = supportKey(baseUrl, modelId);
    if (!baseUrl || !modelId) return;
    set((st) =>
      st.known[key] === transport ? {} : { known: { ...st.known, [key]: transport } },
    );
  },
}));
