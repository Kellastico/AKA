import { describe, expect, it } from "vitest";
import { findBestModelMatch, normalizeModelName } from "../model-match";

describe("normalizeModelName", () => {
  it("strips quant/format/role suffixes but keeps family + size", () => {
    expect(normalizeModelName("qwen2.5-coder-14b-instruct-q4_k_m")).toEqual([
      "qwen2.5",
      "coder",
      "14b",
    ]);
  });

  it("normalizes an Ollama tag to the same family + size shape", () => {
    expect(normalizeModelName("qwen2.5-coder:7b")).toEqual([
      "qwen2.5",
      "coder",
      "7b",
    ]);
  });

  it("keeps version dots intact", () => {
    expect(normalizeModelName("llama3.1:8b")).toEqual(["llama3.1", "8b"]);
  });
});

describe("findBestModelMatch", () => {
  it("maps a GGUF filename to the equivalent Ollama tag (same family + size)", () => {
    expect(
      findBestModelMatch("qwen2.5-coder-14b-instruct-q4_k_m", [
        "qwen2.5-coder:14b",
        "llama3.1:8b",
      ]),
    ).toBe("qwen2.5-coder:14b");
  });

  it("refuses to swap to a different parameter size", () => {
    // The real case from the bug report: 14B selected, only 7B available.
    expect(
      findBestModelMatch("qwen2.5-coder-14b-instruct-q4_k_m", [
        "qwen2.5-coder:7b",
        "llama3.1:8b",
      ]),
    ).toBeNull();
  });

  it("returns an exact id immediately", () => {
    expect(
      findBestModelMatch("qwen2.5-coder:7b", ["qwen2.5-coder:7b"]),
    ).toBe("qwen2.5-coder:7b");
  });

  it("requires every family token (won't match a different model of same size)", () => {
    expect(
      findBestModelMatch("qwen2.5-coder-14b-instruct", ["llama3.1:14b"]),
    ).toBeNull();
  });

  it("prefers the closest (fewest extra tokens) among valid candidates", () => {
    expect(
      findBestModelMatch("qwen2.5-coder-14b", [
        "qwen2.5-coder-14b-instruct-fp16-special",
        "qwen2.5-coder:14b",
      ]),
    ).toBe("qwen2.5-coder:14b");
  });

  it("matches family-only when the old model has no size", () => {
    expect(findBestModelMatch("codellama", ["codellama:13b"])).toBe(
      "codellama:13b",
    );
  });

  it("does not match a sized old model against a sizeless candidate", () => {
    expect(findBestModelMatch("qwen2.5-coder-14b", ["qwen2.5-coder"])).toBeNull();
  });

  it("returns null when nothing is close", () => {
    expect(
      findBestModelMatch("qwen2.5-coder:7b", ["mistral:7b", "phi3:mini"]),
    ).toBeNull();
  });
});
