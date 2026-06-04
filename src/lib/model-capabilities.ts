/**
 * Lightweight, string-based detection of model capabilities. Local runtimes
 * don't advertise modality in /models, so we identify known multimodal
 * families by substring. Used to gate the image attachment option in the chat
 * box — text files / folders / URLs work with any LLM, but images only make
 * sense for vision-capable models.
 *
 * Returning `false` is the safe default. New families just need to be added
 * here when the heuristic misses them.
 */
export function isMultimodalModel(
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();

  // Google
  if (m.includes("gemma3") || m.includes("gemma4")) return true;
  if (m.includes("gemini")) return true;

  // Meta — Llama 3.2 vision variants (11b, 90b)
  if (/llama-?3\.2.*(11b|90b|vision)/.test(m)) return true;

  // LLaVA / BakLLaVA / MiniCPM-V / Moondream
  if (m.includes("llava") || m.includes("bakllava")) return true;
  if (m.includes("minicpm-v") || m.includes("moondream")) return true;

  // Qwen vision
  if (m.includes("qwen2-vl") || m.includes("qwen2.5-vl")) return true;

  // Mistral Pixtral
  if (m.includes("pixtral")) return true;

  // Anthropic — all current Claude models are multimodal
  if (m.includes("claude")) return true;

  // OpenAI vision-capable
  if (
    m.includes("gpt-4o") ||
    m.includes("gpt-4-vision") ||
    m.includes("gpt-4.1") ||
    m.includes("gpt-4-turbo")
  ) {
    return true;
  }

  // Generic catch-all: any model whose id contains "vision" or "-vl".
  if (m.includes("vision") || /(^|[-_:/])vl(\b|[-_:/])/.test(m)) return true;

  return false;
}
