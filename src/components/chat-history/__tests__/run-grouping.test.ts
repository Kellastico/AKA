import { describe, it, expect } from "vitest";
import { groupRunMessages } from "../run-grouping";
import type { Message } from "../../../stores/use-messages-store";

/** Minimal message factory — only the fields grouping cares about. */
function msg(id: string, role: Message["role"]): Message {
  return { id, role, content: "", timestamp: "00:00" };
}

describe("groupRunMessages", () => {
  it("keeps a plain user + Ask-mode assistant as separate singles", () => {
    const groups = groupRunMessages([msg("u1", "user"), msg("a1", "assistant")]);
    expect(groups.map((g) => g.kind)).toEqual(["single", "single"]);
  });

  it("folds interleaved reasoning + tool + answer into one run", () => {
    const groups = groupRunMessages([
      msg("u1", "user"),
      msg("r1", "reasoning"),
      msg("t1", "tool"),
      msg("r2", "reasoning"),
      msg("t2", "tool"),
      msg("a1", "assistant"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ kind: "single", message: expect.objectContaining({ id: "u1" }), key: "u1" });
    expect(groups[1].kind).toBe("run");
    if (groups[1].kind === "run") {
      // Order preserved exactly, answer absorbed at the end.
      expect(groups[1].messages.map((m) => m.id)).toEqual([
        "r1",
        "t1",
        "r2",
        "t2",
        "a1",
      ]);
    }
  });

  it("absorbs only the immediate answer, then starts a fresh group", () => {
    const groups = groupRunMessages([
      msg("t1", "tool"),
      msg("a1", "assistant"),
      msg("u2", "user"),
      msg("t2", "tool"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["run", "single", "run"]);
    if (groups[0].kind === "run")
      expect(groups[0].messages.map((m) => m.id)).toEqual(["t1", "a1"]);
    if (groups[2].kind === "run")
      expect(groups[2].messages.map((m) => m.id)).toEqual(["t2"]);
  });

  it("handles a legacy run (tools then assistant-with-reasoning)", () => {
    const groups = groupRunMessages([msg("t1", "tool"), msg("t2", "tool"), msg("a1", "assistant")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("run");
  });
});
