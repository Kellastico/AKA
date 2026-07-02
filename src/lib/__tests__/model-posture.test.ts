import { describe, it, expect } from "vitest";
import {
  classifyModel,
  classifyStrength,
  isFrontierModel,
  mergeServerCapabilities,
  postureToDial,
  profileTier,
  recommendPosture,
  supportsNativeToolCalling,
} from "../model-posture";

describe("isFrontierModel", () => {
  it("flags cloud flagships, not local lookalikes", () => {
    for (const id of ["gpt-4o", "gpt-5", "o3-mini", "claude-opus-4", "gemini-2.0-flash", "grok-2"]) {
      expect(isFrontierModel(id)).toBe(true);
    }
    // Local Gemma is not Gemini; a sized local model is judged by size, not name.
    for (const id of ["gemma3:12b", "llama3.1:8b", "qwen2.5:7b", ""]) {
      expect(isFrontierModel(id)).toBe(false);
    }
  });
});

describe("supportsNativeToolCalling", () => {
  it("recognises known tool-calling families", () => {
    for (const id of [
      "gpt-4o",
      "claude-sonnet-4",
      "qwen2.5:32b",
      "llama-3.1-70b",
      "mistral-nemo",
      "command-r-plus",
      "hermes-3-llama-3.1-8b",
      "granite3-dense",
    ]) {
      expect(supportsNativeToolCalling(id)).toBe(true);
    }
  });

  it("defaults to false for unknown / older models", () => {
    for (const id of ["llama2:7b", "qwen2:7b", "phi3:mini", "vicuna-13b", "mystery-model", null]) {
      expect(supportsNativeToolCalling(id)).toBe(false);
    }
  });
});

describe("profileTier", () => {
  it("buckets by parameter size, frontier as large, unknown as mid", () => {
    expect(profileTier("llama3.2:3b")).toBe("small");
    expect(profileTier("qwen2.5:7b")).toBe("small");
    expect(profileTier("mixtral:8x7b")).toBe("small"); // per-expert 7b
    expect(profileTier("qwen2.5:14b")).toBe("mid");
    expect(profileTier("llama3.1:70b")).toBe("large");
    expect(profileTier("gpt-4o")).toBe("large");
    expect(profileTier("some-unsized-model")).toBe("mid");
  });
});

describe("classifyStrength + recommendPosture", () => {
  it("maps families/sizes to strength and a recommended posture", () => {
    expect(classifyStrength("gpt-4o")).toBe("frontier");
    expect(classifyStrength("llama3.1:70b")).toBe("local-large");
    expect(classifyStrength("llama3.1:8b")).toBe("local-small");
    expect(classifyStrength(null)).toBe("local-small");

    expect(recommendPosture("frontier")).toBe("none");
    expect(recommendPosture("local-large")).toBe("thin");
    expect(recommendPosture("local-small")).toBe("orchestrated");
  });
});

describe("classifyModel", () => {
  it("recommends None for a frontier model", () => {
    const c = classifyModel("claude-opus-4");
    expect(c).toEqual({
      strength: "frontier",
      nativeToolCalling: true,
      profile: "large",
      recommended: "none",
    });
  });

  it("recommends an orchestrated thick posture for a small local model", () => {
    const c = classifyModel("llama2:7b");
    expect(c.strength).toBe("local-small");
    expect(c.nativeToolCalling).toBe(false);
    expect(c.recommended).toBe("orchestrated");
  });
});

describe("mergeServerCapabilities", () => {
  it("lets server truth override the tool-calling heuristic", () => {
    const base = classifyModel("mystery-model"); // heuristic: no tool-calling
    expect(base.nativeToolCalling).toBe(false);
    const refined = mergeServerCapabilities(base, ["completion", "tools"]);
    expect(refined.nativeToolCalling).toBe(true);
    // Strength/profile are untouched by the server capability list.
    expect(refined.strength).toBe(base.strength);
  });

  it("is a no-op for an empty/unknown list", () => {
    const base = classifyModel("qwen2.5:7b");
    expect(mergeServerCapabilities(base, [])).toEqual(base);
    expect(mergeServerCapabilities(base, null)).toEqual(base);
  });
});

describe("postureToDial", () => {
  it("None spawns no agent → no dial", () => {
    expect(postureToDial("none", true)).toBeNull();
  });

  it("thin uses native tool-calls only when the model can, loose gating, long leash", () => {
    expect(postureToDial("thin", true)).toEqual({
      toolcall: "native",
      gating: "loose",
      leash: 24,
    });
    // Capability gates the dial: a thin posture on a tool-call-incapable model
    // still falls back to text.
    expect(postureToDial("thin", false)).toEqual({
      toolcall: "text",
      gating: "loose",
      leash: 24,
    });
  });

  it("thick and orchestrated tighten gating and shorten the leash", () => {
    expect(postureToDial("thick", true)).toEqual({
      toolcall: "text",
      gating: "strict",
      leash: 12,
    });
    const orch = postureToDial("orchestrated", true);
    expect(orch?.gating).toBe("strict");
    expect(orch?.leash).toBe(6);
  });
});
