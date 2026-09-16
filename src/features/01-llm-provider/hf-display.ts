// Display helpers for the HuggingFace picker. Pure functions, kept out of the
// component so the label rules are unit-testable.

/** Parameter count from the GGUF header, e.g. 27320697856 → "27B Parameters". */
export function formatParameters(n: number | null): string | null {
  if (!n || n <= 0) return null;
  const b = n / 1_000_000_000;
  // Models are named by the floor of their billions (a 30.5B MoE is "30B"),
  // so don't round up past the name the repo goes by.
  if (b >= 10) return `${Math.floor(b)}B Parameters`;
  if (b >= 1) return `${b.toFixed(1).replace(/\.0$/, "")}B Parameters`;
  return `${Math.round(n / 1_000_000)}M Parameters`;
}

/** Readable names for the HuggingFace task tags GGUF repos actually carry. */
export function pipelineLabel(tag: string | null): string | null {
  if (!tag) return null;
  switch (tag) {
    case "text-generation":
      return "Text";
    case "image-text-to-text":
      return "Multimodal";
    case "text-to-speech":
      return "Speech";
    case "automatic-speech-recognition":
      return "Transcription";
    case "feature-extraction":
    case "sentence-similarity":
      return "Embeddings";
    default:
      return tag.replace(/-/g, " ");
  }
}

/**
 * Display form of a quant label: `Q4_K_M` → `Q4 M`, `Q3_K_XL` → `Q3 XL`,
 * `IQ4_XXS` → `IQ4 XXS`. Underscores become spaces and the K-quant marker
 * drops out, since `K` says nothing that tells one quant from another.
 *
 * Everything that *identifies* a quant is kept: the `IQ` importance-matrix
 * family and unsloth's `UD` dynamic marker both stay, so no two quants can
 * render the same label — `IQ2_S` and `Q2_K_S` read as `IQ2 S` and `Q2 S`.
 * `quantLabelsAreDistinct` in the tests guards that.
 */
export function prettyQuant(quant: string): string {
  const dynamic = quant.startsWith("UD-");
  const key = dynamic ? quant.slice(3) : quant;
  // Float dumps have no block structure to simplify — but they still keep the
  // dynamic marker, or `UD-BF16` would render identically to plain `BF16`.
  if (/^(BF|FP?)\d+$/.test(key)) return dynamic ? `UD ${key}` : key;
  const [head, ...rest] = key.split("_");
  const tail = rest.filter((p) => p !== "K");
  // `Q8_0`'s trailing 0 is a format version, not a variant — `Q4_1` keeps its 1.
  if (tail.length === 1 && tail[0] === "0") tail.pop();
  return [dynamic ? "UD" : null, head, ...tail].filter(Boolean).join(" ");
}

/** Quants a row leads with when the user hasn't filtered on one. */
const PREFERRED_QUANTS = [
  "Q4_K_M",
  "UD-Q4_K_XL",
  "Q4_K_XL",
  "Q4_K_S",
  "IQ4_XS",
  "Q5_K_M",
  "Q6_K",
  "Q8_0",
];

/**
 * The single quant a row stands for. A quant the user filtered on wins, so the
 * row answers the question they asked; otherwise it's the sensible default
 * most people download.
 */
export function representativeQuant(
  quants: string[],
  selected: string[],
): string | null {
  return (
    selected.find((q) => quants.includes(q)) ??
    PREFERRED_QUANTS.find((q) => quants.includes(q)) ??
    quants[0] ??
    null
  );
}
