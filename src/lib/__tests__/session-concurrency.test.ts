import { describe, expect, it } from "vitest";
import {
  adviceForNewSession,
  allSameModel,
  gateForRun,
  isLimitedHardware,
  type RunningSession,
} from "../session-concurrency";

const s = (sessionId: string, modelId: string | null): RunningSession => ({
  sessionId,
  modelId,
});

describe("isLimitedHardware", () => {
  it("treats unknown/zero RAM as not limited (never warn on missing data)", () => {
    expect(isLimitedHardware(null)).toBe(false);
    expect(isLimitedHardware(undefined)).toBe(false);
    expect(isLimitedHardware(0)).toBe(false);
  });

  it("flags machines at or below 16 GB", () => {
    expect(isLimitedHardware(8)).toBe(true);
    expect(isLimitedHardware(16)).toBe(true);
    // f32 readback wobble around a nominal 16 GB machine
    expect(isLimitedHardware(15.93)).toBe(true);
    expect(isLimitedHardware(16.02)).toBe(true);
  });

  it("does not flag the next tier up (18 GB+)", () => {
    expect(isLimitedHardware(18)).toBe(false);
    expect(isLimitedHardware(24)).toBe(false);
    expect(isLimitedHardware(32)).toBe(false);
    expect(isLimitedHardware(64)).toBe(false);
  });
});

describe("allSameModel", () => {
  it("is false with no running sessions", () => {
    expect(allSameModel([], "qwen")).toBe(false);
  });

  it("is true only when every running session shares the incoming model", () => {
    expect(allSameModel([s("a", "qwen"), s("b", "qwen")], "qwen")).toBe(true);
    expect(allSameModel([s("a", "qwen"), s("b", "llama")], "qwen")).toBe(false);
    expect(allSameModel([s("a", "qwen")], "llama")).toBe(false);
  });

  it("treats a null incoming model as a divergence", () => {
    expect(allSameModel([s("a", "qwen")], null)).toBe(false);
  });
});

describe("gateForRun", () => {
  it("allows the first run (nothing else running)", () => {
    expect(
      gateForRun({ totalRamGb: 16, runningSessions: [], incomingModelId: "qwen" }),
    ).toEqual({ kind: "allow" });
  });

  it("allows concurrency on roomy hardware regardless of model", () => {
    expect(
      gateForRun({
        totalRamGb: 32,
        runningSessions: [s("a", "qwen")],
        incomingModelId: "llama",
      }),
    ).toEqual({ kind: "allow" });
  });

  it("allows same-model concurrency even on limited hardware", () => {
    expect(
      gateForRun({
        totalRamGb: 16,
        runningSessions: [s("a", "qwen"), s("b", "qwen")],
        incomingModelId: "qwen",
      }),
    ).toEqual({ kind: "allow" });
  });

  it("warns on limited hardware when a different model would load alongside", () => {
    expect(
      gateForRun({
        totalRamGb: 16,
        runningSessions: [s("a", "qwen")],
        incomingModelId: "llama",
      }),
    ).toEqual({ kind: "warn-ram", runningModels: ["qwen"], incomingModelId: "llama" });
  });

  it("dedupes running models in the warning payload", () => {
    const gate = gateForRun({
      totalRamGb: 8,
      runningSessions: [s("a", "qwen"), s("b", "qwen"), s("c", "phi")],
      incomingModelId: "llama",
    });
    expect(gate).toEqual({
      kind: "warn-ram",
      runningModels: ["qwen", "phi"],
      incomingModelId: "llama",
    });
  });

  it("warns when the incoming model is unknown on limited hardware", () => {
    expect(
      gateForRun({
        totalRamGb: 16,
        runningSessions: [s("a", "qwen")],
        incomingModelId: null,
      }),
    ).toEqual({ kind: "warn-ram", runningModels: ["qwen"], incomingModelId: null });
  });
});

describe("adviceForNewSession", () => {
  it("advises reuse on limited hardware with a live concurrent run", () => {
    expect(
      adviceForNewSession({ totalRamGb: 16, runningSessions: [s("a", "qwen")] }),
    ).toBe(true);
  });

  it("stays quiet when nothing else is running", () => {
    expect(adviceForNewSession({ totalRamGb: 16, runningSessions: [] })).toBe(false);
  });

  it("stays quiet on roomy hardware", () => {
    expect(
      adviceForNewSession({ totalRamGb: 32, runningSessions: [s("a", "qwen")] }),
    ).toBe(false);
  });
});
