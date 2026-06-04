// Curated, ÄKÄ-tested model catalog for the built-in runtime. Static for now;
// could later be fetched from a bundled/remote JSON without changing the UI.
// Sizes/RAM are approximate guidance — the RAM gate uses `minRamGb`.

export type ModelTierName = "light" | "standard" | "pro";

export interface CuratedModel {
  id: string;
  name: string;
  description: string;
  huggingfaceRepo: string;
  /** The exact `.gguf` filename in the repo (also the on-disk filename). */
  filename: string;
  /** Download size in GB. */
  sizeGb: number;
  /** Minimum system RAM (GB) to run comfortably. */
  minRamGb: number;
  tier: ModelTierName;
  tags: string[];
  contextWindow: number;
  /** ÄKÄ-tested and confirmed working. */
  verified: boolean;
}

/** The model id the runtime addresses is the filename without its extension. */
export function modelIdFromFilename(filename: string): string {
  return filename.replace(/\.gguf$/i, "");
}

export const CURATED_MODELS: CuratedModel[] = [
  {
    id: "qwen2.5-coder-3b-q4",
    name: "Qwen2.5-Coder 3B",
    description: "Fastest coding model — great on modest hardware.",
    huggingfaceRepo: "Qwen/Qwen2.5-Coder-3B-Instruct-GGUF",
    filename: "qwen2.5-coder-3b-instruct-q4_k_m.gguf",
    sizeGb: 2.0,
    minRamGb: 4,
    tier: "light",
    tags: ["coding", "fast"],
    contextWindow: 32768,
    verified: true,
  },
  {
    id: "qwen2.5-coder-7b-q4",
    name: "Qwen2.5-Coder 7B",
    description: "Best balance of speed and quality for everyday coding.",
    huggingfaceRepo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
    filename: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    sizeGb: 4.7,
    minRamGb: 8,
    tier: "standard",
    tags: ["coding", "balanced"],
    contextWindow: 32768,
    verified: true,
  },
  {
    id: "qwen2.5-coder-14b-q4",
    name: "Qwen2.5-Coder 14B",
    description: "Highest quality — for 16GB+ machines.",
    huggingfaceRepo: "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF",
    filename: "qwen2.5-coder-14b-instruct-q4_k_m.gguf",
    sizeGb: 9.0,
    minRamGb: 16,
    tier: "pro",
    tags: ["coding", "large-context"],
    contextWindow: 32768,
    verified: true,
  },
  {
    id: "deepseek-coder-v2-lite-q4",
    name: "DeepSeek-Coder-V2-Lite",
    description: "Strong at reasoning and multi-step coding tasks.",
    huggingfaceRepo: "lmstudio-community/DeepSeek-Coder-V2-Lite-Instruct-GGUF",
    filename: "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf",
    sizeGb: 10.4,
    minRamGb: 8,
    tier: "standard",
    tags: ["coding", "reasoning"],
    contextWindow: 163840,
    verified: true,
  },
];

/** Format a context window for display, e.g. 32768 → "32k ctx". */
export function formatContext(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}
