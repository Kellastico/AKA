import { describe, expect, it } from "vitest";
import { shouldNudgeToolReliability } from "../../components/chatbox/ToolReliabilityNudge";
import { NONE_AGENT, type Agent } from "../../stores/use-agents-store";

// A registered external agent (has a bin) — never the built-in loop.
const EXTERNAL_AGENT: Agent = {
  ...NONE_AGENT,
  id: "aider",
  name: "Aider",
  bin: "aider",
};

describe("shouldNudgeToolReliability", () => {
  it("shows for Execute + None with a text-protocol model (no native tool-calling)", () => {
    expect(
      shouldNudgeToolReliability({
        mode: "agent",
        agent: NONE_AGENT,
        modelId: "gemma4:12b",
        suppressed: false,
      }),
    ).toBe(true);
  });

  it("hides when the model DOES support native tool-calling", () => {
    for (const m of ["qwen2.5-coder:7b", "llama-3.1-8b", "gpt-4o"]) {
      expect(
        shouldNudgeToolReliability({
          mode: "agent",
          agent: NONE_AGENT,
          modelId: m,
          suppressed: false,
        }),
      ).toBe(false);
    }
  });

  it("hides outside Execute mode", () => {
    for (const mode of ["ask", "edit"] as const) {
      expect(
        shouldNudgeToolReliability({
          mode,
          agent: NONE_AGENT,
          modelId: "gemma4:12b",
          suppressed: false,
        }),
      ).toBe(false);
    }
  });

  it("hides for an external agent (its own tool story, not the built-in loop)", () => {
    expect(
      shouldNudgeToolReliability({
        mode: "agent",
        agent: EXTERNAL_AGENT,
        modelId: "gemma4:12b",
        suppressed: false,
      }),
    ).toBe(false);
  });

  it("hides when no model is selected", () => {
    expect(
      shouldNudgeToolReliability({
        mode: "agent",
        agent: NONE_AGENT,
        modelId: null,
        suppressed: false,
      }),
    ).toBe(false);
  });

  it("hides once the user has dismissed it", () => {
    expect(
      shouldNudgeToolReliability({
        mode: "agent",
        agent: NONE_AGENT,
        modelId: "gemma4:12b",
        suppressed: true,
      }),
    ).toBe(false);
  });
});
