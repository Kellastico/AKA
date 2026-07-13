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
  it("shows for Execute + None when the evidence says text fallback", () => {
    expect(
      shouldNudgeToolReliability({
        mode: "agent",
        agent: NONE_AGENT,
        modelId: "gemma4:12b",
        transport: "text", // runtime advertised no tools, or a run fell back
        suppressed: false,
      }),
    ).toBe(true);
  });

  it("hides when the evidence says native", () => {
    expect(
      shouldNudgeToolReliability({
        mode: "agent",
        agent: NONE_AGENT,
        modelId: "gemma4:12b", // name is irrelevant — evidence decides
        transport: "native",
        suppressed: false,
      }),
    ).toBe(false);
  });

  it("hides when nothing is known yet (the loop will try native first)", () => {
    expect(
      shouldNudgeToolReliability({
        mode: "agent",
        agent: NONE_AGENT,
        modelId: "some-unheard-of-model",
        transport: undefined,
        suppressed: false,
      }),
    ).toBe(false);
  });

  it("hides outside Execute mode", () => {
    for (const mode of ["ask", "edit"] as const) {
      expect(
        shouldNudgeToolReliability({
          mode,
          agent: NONE_AGENT,
          modelId: "gemma4:12b",
          transport: "text",
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
        transport: "text",
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
        transport: "text",
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
        transport: "text",
        suppressed: true,
      }),
    ).toBe(false);
  });
});
