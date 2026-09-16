import { describe, expect, it } from "vitest";
import {
  MIN_CONTEXT,
  estimateContext,
  formatContextSize,
  maxContextFor,
} from "../context-size";

// Real numbers read from a loaded model, not invented for the test:
// MiniCPM-V 4.6 reports 24576 bytes of KV per token and a 262144-token
// trained window, with 1446 MB of weights.
const KV_PER_TOKEN = 24_576;
const MODEL_MB = 1446;

describe("maxContextFor", () => {
  it("uses the model's own trained window", () => {
    expect(maxContextFor(262_144, 8_192)).toBe(262_144);
    // A small model must not be offered a large window.
    expect(maxContextFor(4_096, 8_192)).toBe(4_096);
  });

  it("falls back to the current window when the model reports nothing", () => {
    expect(maxContextFor(null, 8_192)).toBe(8_192);
    expect(maxContextFor(undefined, 32_768)).toBe(32_768);
  });

  it("never produces a range the slider can't render", () => {
    expect(maxContextFor(0, 0)).toBe(MIN_CONTEXT);
    expect(maxContextFor(null, 128)).toBe(MIN_CONTEXT);
  });
});

describe("estimateContext", () => {
  const base = { kvBytesPerToken: KV_PER_TOKEN, modelMb: MODEL_MB, totalRamGb: 16 };

  it("scales the KV cache linearly with the window", () => {
    const a = estimateContext({ ...base, ctxSize: 32_768 })!;
    const b = estimateContext({ ...base, ctxSize: 65_536 })!;
    expect(b.kvGb).toBeCloseTo(a.kvGb * 2, 5);
    // 24576 bytes * 32768 tokens = 0.75 GB
    expect(a.kvGb).toBeCloseTo(0.75, 2);
  });

  it("stays quiet when the window comfortably fits", () => {
    const e = estimateContext({ ...base, ctxSize: 8_192 })!;
    expect(e.risk).toBe("ok");
    expect(e.warning).toBeNull();
  });

  it("warns starkly once the machine is nearly full", () => {
    // A 9 GB model on 16 GB: weights alone are 56%, so a large window tips it.
    const e = estimateContext({
      ...base,
      modelMb: 9_216,
      ctxSize: 131_072,
    })!;
    expect(e.risk).toBe("tight");
    expect(e.warning).toMatch(/swapping/i);
  });

  it("warns that the runtime will crash once it exceeds RAM", () => {
    // 12 GB of weights plus 6 GB of KV is 18 GB on a 16 GB machine.
    const e = estimateContext({
      ...base,
      modelMb: 12_288,
      ctxSize: 262_144,
    })!;
    expect(e.risk).toBe("over");
    expect(e.warning).toMatch(/crash/i);
  });

  it("returns null rather than guessing when the model is unknown", () => {
    // External runtimes don't report their architecture; showing an invented
    // number would be worse than showing none.
    expect(estimateContext({ ...base, ctxSize: 8_192, kvBytesPerToken: null })).toBeNull();
    expect(estimateContext({ ...base, ctxSize: 8_192, kvBytesPerToken: 0 })).toBeNull();
  });

  it("still prices the window when the machine's RAM is unknown", () => {
    const e = estimateContext({ ...base, ctxSize: 8_192, totalRamGb: null })!;
    expect(e.kvGb).toBeGreaterThan(0);
    expect(e.risk).toBe("ok");
    expect(e.warning).toBeNull();
  });
});

describe("the model-switch crash", () => {
  // Numbers read from the GGUF headers of three real models on a 16 GB machine.
  // Setting a large window on the small model and switching to either of the
  // others is what took the machine down: the window carried over, but its
  // cost per token did not.
  const RAM = 16;
  const MINICPM = { kvBytesPerToken: 24_576, modelMb: 1_446 };
  const ORNITH = { kvBytesPerToken: 131_072, modelMb: 5_324 };
  const QWEN14B = { kvBytesPerToken: 196_608, modelMb: 8_602 };

  it("is harmless on the model the window was chosen for", () => {
    const e = estimateContext({ ...MINICPM, ctxSize: 262_144, totalRamGb: RAM })!;
    expect(e.risk).toBe("ok");
    expect(e.totalGb).toBeCloseTo(7.4, 0);
  });

  it("is caught on the model that was switched to", () => {
    // 32 GB of KV on a 16 GB machine — this is the crash.
    const ornith = estimateContext({ ...ORNITH, ctxSize: 262_144, totalRamGb: RAM })!;
    expect(ornith.risk).toBe("over");
    expect(ornith.totalGb).toBeCloseTo(37.2, 0);

    // 48 GB of KV — worse still.
    const qwen = estimateContext({ ...QWEN14B, ctxSize: 262_144, totalRamGb: RAM })!;
    expect(qwen.risk).toBe("over");
    expect(qwen.totalGb).toBeCloseTo(56.4, 0);
  });

  it("is still caught at the model's own trained maximum", () => {
    // The trained window is not a safety bound: Qwen 14B is trained to 131k,
    // and 131k of KV is 24 GB — still far past a 16 GB machine. Capping the
    // slider at the model's window alone would not have prevented this.
    const e = estimateContext({ ...QWEN14B, ctxSize: 131_072, totalRamGb: RAM })!;
    expect(e.risk).toBe("over");
  });

  it("names the window that would actually fit", () => {
    const e = estimateContext({
      ...QWEN14B,
      ctxSize: 262_144,
      totalRamGb: RAM,
      maxFittingCtx: 18_000,
    })!;
    expect(e.warning).toMatch(/safely hold here is 18k/);
  });
});

describe("formatContextSize", () => {
  it("reads as the sizes people actually say", () => {
    expect(formatContextSize(8_192)).toBe("8k");
    expect(formatContextSize(131_072)).toBe("128k");
    expect(formatContextSize(262_144)).toBe("256k");
    expect(formatContextSize(512)).toBe("512");
  });
});
