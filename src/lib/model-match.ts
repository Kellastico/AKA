/**
 * Cross-runtime model-name matching.
 *
 * Different runtimes name the same model differently: the built-in sidecar
 * serves GGUF filenames (`qwen2.5-coder-14b-instruct-q4_k_m`) while Ollama uses
 * tags (`qwen2.5-coder:14b`). When the user switches runtimes mid-session, AKA
 * tries to carry their selection over by matching on the parts that actually
 * identify the model — family + size — and ignoring quantization, format, and
 * role suffixes that differ between packagings.
 *
 * The matcher is deliberately *conservative*: it only returns a candidate when
 * it shares every family token AND the same parameter size. A wrong auto-pick
 * (e.g. silently swapping a 14B for a 7B) is worse than asking the user, so a
 * near-miss returns null and the caller prompts for a manual choice.
 */

// Tokens that describe packaging/role, not the model itself — dropped before
// comparison so `…-instruct-q4_k_m` and `:14b` compare equal on what matters.
const DROP_TOKENS = new Set([
  "gguf", "instruct", "chat", "it", "hf", "base", "v1",
  "bf16", "f16", "f32", "fp16", "fp32", "int8", "int4", "awq", "gptq", "mlx",
]);

/** A parameter-size token like `7b`, `14b`, `1.5b`, `70b`, `405b`. */
function isSizeToken(t: string): boolean {
  return /^\d+(\.\d+)?b$/.test(t);
}

/** A quantization token like `q4`, `q8`, or a stray quant letter (`k`, `m`, `s`, `l`). */
function isQuantToken(t: string): boolean {
  return /^q\d+$/.test(t) || /^(k|m|s|l|xs|xl)$/.test(t) || /^\d+bit$/.test(t);
}

/**
 * Reduce a model id to its identifying tokens. Lowercased, split on `/ : _ -`
 * (version dots like `qwen2.5` are kept intact), with packaging/quant/role
 * tokens stripped. Order is preserved; the first token is the "primary" family.
 */
export function normalizeModelName(name: string): string[] {
  return name
    .toLowerCase()
    .trim()
    .replace(/[/:_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !DROP_TOKENS.has(t) && !isQuantToken(t));
}

/**
 * Pick the best equivalent of `oldModel` from `candidates`, or null when none
 * is a confident match. "Confident" means: every family token of the old model
 * is present in the candidate, and parameter sizes agree (when the old model
 * specifies one). Ties break toward the candidate with the fewest extra tokens
 * (the closest, least-embellished name).
 */
export function findBestModelMatch(
  oldModel: string,
  candidates: string[],
): string | null {
  const oldTokens = normalizeModelName(oldModel);
  if (oldTokens.length === 0) return null;

  const oldSize = oldTokens.find(isSizeToken) ?? null;
  const oldFamily = oldTokens.filter((t) => !isSizeToken(t));
  if (oldFamily.length === 0) return null; // size alone isn't enough to match on

  let best: string | null = null;
  let bestExtra = Infinity;

  for (const candidate of candidates) {
    if (candidate === oldModel) return candidate; // exact id — can't do better
    const candTokens = normalizeModelName(candidate);
    const candSize = candTokens.find(isSizeToken) ?? null;

    // Sizes must agree. If the old model pins a size, the candidate must pin the
    // same one — never silently swap 14B for 7B (or for an unknown size).
    if (oldSize !== null && candSize !== oldSize) continue;

    // Every family token of the old model must be present in the candidate.
    if (!oldFamily.every((t) => candTokens.includes(t))) continue;

    const extra = candTokens.length - oldTokens.length;
    if (extra < bestExtra) {
      best = candidate;
      bestExtra = extra;
    }
  }

  return best;
}
