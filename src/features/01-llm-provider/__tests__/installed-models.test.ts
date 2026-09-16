import { describe, expect, it } from "vitest";
import {
  fitsHardware,
  installedBrowserModels,
  type DownloadState,
} from "../use-model-browser-store";
import type { CuratedModel } from "../curated-models";

const GB = 1_073_741_824;

const dl = (totalBytes: number): DownloadState => ({
  bytesDownloaded: totalBytes / 2,
  totalBytes,
  percent: 50,
  startedAt: 0,
  bytesPerSec: 1_000_000,
});

const model = (over: Partial<CuratedModel> = {}): CuratedModel => ({
  id: "m",
  name: "m",
  description: "",
  huggingfaceRepo: "",
  filename: "m.gguf",
  sizeGb: 4,
  minRamGb: 6,
  tier: "standard",
  tags: [],
  contextWindow: 0,
  verified: false,
  ...over,
});

describe("installedBrowserModels", () => {
  it("lists nothing when nothing is downloaded — no suggestions", () => {
    expect(installedBrowserModels([], {})).toEqual([]);
  });

  it("lists only what is on disk", () => {
    const rows = installedBrowserModels(
      [{ filename: "ornith-1.0-9b.gguf", sizeBytes: 5.6 * GB }],
      {},
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("ornith-1.0-9b.gguf");
  });

  it("names a model after its file, without the extension", () => {
    const [row] = installedBrowserModels(
      [{ filename: "qwen2.5-coder-7b-instruct-q4_k_m.gguf", sizeBytes: 4.7 * GB }],
      {},
    );
    expect(row.name).toBe("qwen2.5-coder-7b-instruct-q4_k_m");
  });

  it("estimates a RAM requirement from the file size", () => {
    const [row] = installedBrowserModels(
      [{ filename: "a.gguf", sizeBytes: 5.6 * GB }],
      {},
    );
    // Weights plus headroom, rounded up.
    expect(row.minRamGb).toBe(Math.ceil(5.6 + 1.5));
  });

  it("includes a download still in flight, so progress stays reachable", () => {
    const rows = installedBrowserModels([], { "arriving.gguf": dl(3 * GB) });
    expect(rows.map((r) => r.filename)).toEqual(["arriving.gguf"]);
  });

  it("does not list a model twice while its download finishes", () => {
    const rows = installedBrowserModels(
      [{ filename: "a.gguf", sizeBytes: 3 * GB }],
      { "a.gguf": dl(3 * GB) },
    );
    expect(rows).toHaveLength(1);
  });

  it("prefers the on-disk size over the download's reported total", () => {
    const [row] = installedBrowserModels(
      [{ filename: "a.gguf", sizeBytes: 3 * GB }],
      { "a.gguf": dl(99 * GB) },
    );
    expect(Math.round(row.sizeGb)).toBe(3);
  });

  it("sorts by name so the list is stable across refreshes", () => {
    const rows = installedBrowserModels(
      [
        { filename: "zeta.gguf", sizeBytes: GB },
        { filename: "Alpha.gguf", sizeBytes: GB },
        { filename: "mid.gguf", sizeBytes: GB },
      ],
      {},
    );
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "mid", "zeta"]);
  });

  it("carries no catalog metadata — nothing is presented as verified", () => {
    const [row] = installedBrowserModels(
      [{ filename: "qwen2.5-coder-7b-instruct-q4_k_m.gguf", sizeBytes: 4.7 * GB }],
      {},
    );
    expect(row.verified).toBe(false);
    expect(row.description).toBe("");
    expect(row.contextWindow).toBe(0);
  });
});

describe("fitsHardware", () => {
  it("fits when the requirement is under the machine's RAM", () => {
    expect(fitsHardware(model({ minRamGb: 8 }), 16)).toBe(true);
  });

  it("fits exactly at the machine's RAM", () => {
    expect(fitsHardware(model({ minRamGb: 16 }), 16)).toBe(true);
  });

  it("does not fit above the machine's RAM", () => {
    expect(fitsHardware(model({ minRamGb: 44 }), 16)).toBe(false);
  });

  it("assumes it fits when the machine's RAM is unknown", () => {
    // Browser preview and probe failures report 0 — never hide a model then.
    expect(fitsHardware(model({ minRamGb: 44 }), 0)).toBe(true);
  });

  it("assumes it fits when the model's requirement is unknown", () => {
    expect(fitsHardware(model({ minRamGb: 0 }), 8)).toBe(true);
  });
});
