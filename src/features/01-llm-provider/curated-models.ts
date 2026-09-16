// Model descriptor shared by the Model Browser and the download pipeline.
//
// This used to carry a curated, ÄKÄ-tested catalog that the Manage Models list
// advertised alongside your own files. That catalog is gone: Manage Models now
// shows only what is actually on disk (or arriving), so AKA no longer suggests
// models you haven't chosen. What survives here is the *shape* a download is
// described by — the HuggingFace flow builds one of these per file, and the RAM
// gate and progress plumbing read it.

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
  /** Minimum system RAM (GB) to run comfortably. 0 when unknown. */
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
