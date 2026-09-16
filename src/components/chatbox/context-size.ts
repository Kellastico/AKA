// Pricing a context window against the machine it has to run on.
//
// The KV cache is the part of a model's footprint that grows with the context
// window, and it grows exactly linearly: every token of context costs a fixed
// number of bytes for a given architecture. The runtime reports that constant,
// so any window can be priced without re-deriving anything.
//
// Nothing here blocks a choice. It produces the wording for a warning; the
// decision stays with the person whose machine it is.

/** Smallest window worth offering — below this most prompts won't fit. */
export const MIN_CONTEXT = 1_024;

/** Slider granularity, in tokens. */
export const CONTEXT_STEP = 1_024;

/**
 * Upper bound of the slider: the largest context the loaded model was actually
 * trained for, reported by the runtime from the model's own metadata.
 *
 * This is deliberately the model's number rather than a fixed ladder of sizes —
 * a 4k model should not offer 128k, and a 262k model should not be capped at
 * 32k because of a hardcoded list. Falls back to the current window only when
 * the model hasn't reported one, so the slider always has a valid range.
 *
 * Note this is NOT the safety bound. A trained window is routinely far larger
 * than the machine can hold — a 14B model's 131k window is 24 GB of KV cache —
 * so `estimateContext` prices every position against RAM independently.
 */
export function maxContextFor(
  nCtxTrain: number | null | undefined,
  current: number,
): number {
  const cap = nCtxTrain && nCtxTrain > 0 ? nCtxTrain : current;
  return Math.max(cap, MIN_CONTEXT);
}

export type ContextRisk = "ok" | "tight" | "over";

export type ContextEstimate = {
  /** KV cache for this window, in GB. */
  kvGb: number;
  /** Model weights + KV cache, in GB. */
  totalGb: number;
  /** Share of the machine's RAM this would occupy, 0-1. */
  ramFraction: number;
  risk: ContextRisk;
  /** Stark, plain warning. null when the window is comfortable. */
  warning: string | null;
  /** Largest window that still fits this machine, when the runtime reports it. */
  safeMax: number | null;
};

function gb(bytes: number): number {
  return bytes / 1_073_741_824;
}

function fmtGb(v: number): string {
  return v >= 10 ? `${Math.round(v)} GB` : `${v.toFixed(1)} GB`;
}

/**
 * Price `ctxSize` for the loaded model on this machine.
 *
 * Returns null when the inputs aren't known — no model loaded, or an external
 * runtime that doesn't report its architecture. The UI shows the control
 * without a warning rather than inventing one.
 */
export function estimateContext({
  ctxSize,
  kvBytesPerToken,
  modelMb,
  totalRamGb,
  maxFittingCtx,
}: {
  ctxSize: number;
  kvBytesPerToken: number | null | undefined;
  modelMb: number;
  totalRamGb: number | null | undefined;
  /** Largest window the runtime says fits this machine, when known. */
  maxFittingCtx?: number | null;
}): ContextEstimate | null {
  if (!kvBytesPerToken || kvBytesPerToken <= 0) return null;

  const kvGb = gb(kvBytesPerToken * ctxSize);
  const modelGb = modelMb / 1024;
  const totalGb = modelGb + kvGb;

  if (!totalRamGb || totalRamGb <= 0) {
    return { kvGb, totalGb, ramFraction: 0, risk: "ok", warning: null, safeMax: maxFittingCtx ?? null };
  }

  const ramFraction = totalGb / totalRamGb;

  // Past total RAM there is nowhere for the cache to live: llama.cpp allocates
  // it up front, so the failure is an immediate hard one, not a slow crawl.
  if (ramFraction >= 1) {
    return {
      kvGb,
      totalGb,
      ramFraction,
      safeMax: maxFittingCtx ?? null,
      risk: "over",
      warning:
        `This needs about ${fmtGb(totalGb)} but the machine has ${fmtGb(totalRamGb)}. ` +
        `The runtime will almost certainly crash, and may take other apps down with it.` +
        (maxFittingCtx
          ? ` The most this model can safely hold here is ${formatContextSize(maxFittingCtx)}.`
          : ""),
    };
  }

  // Above ~75% the OS is left without room for everything else, and on a
  // machine with unified memory that is the same pool the GPU is drawing from.
  if (ramFraction >= 0.75) {
    return {
      kvGb,
      totalGb,
      ramFraction,
      safeMax: maxFittingCtx ?? null,
      risk: "tight",
      warning:
        `This needs about ${fmtGb(totalGb)} of your ${fmtGb(totalRamGb)}. ` +
        `Expect heavy swapping and a slow, unstable machine.`,
    };
  }

  return { kvGb, totalGb, ramFraction, risk: "ok", warning: null, safeMax: maxFittingCtx ?? null };
}

/** `8192` → `8k`, `131072` → `128k`. */
export function formatContextSize(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}
