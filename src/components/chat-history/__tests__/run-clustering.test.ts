import { describe, it, expect } from "vitest";
import { clusterNodes, groupSummary, type RunNode } from "../RunTimeline";
import type { Message } from "../../../stores/use-messages-store";

function tool(id: string, kind: Message["toolKind"]): RunNode {
  return { type: "tool", msg: { id, role: "tool", content: "", timestamp: "0", toolKind: kind }, key: id };
}
function reasoning(id: string): RunNode {
  return { type: "reasoning", msg: { id, role: "reasoning", content: "", timestamp: "0" }, key: id };
}

describe("clusterNodes", () => {
  it("shows 1–2 consecutive tools inline, but groups 3+", () => {
    const one = clusterNodes([reasoning("r1"), tool("t1", "read")]);
    expect(one.map((i) => i.kind)).toEqual(["reasoning", "tool"]);

    const two = clusterNodes([reasoning("r1"), tool("t1", "read"), tool("t2", "read")]);
    expect(two.map((i) => i.kind)).toEqual(["reasoning", "tool", "tool"]);

    const three = clusterNodes([
      reasoning("r1"),
      tool("t1", "read"),
      tool("t2", "read"),
      tool("t3", "read"),
    ]);
    expect(three.map((i) => i.kind)).toEqual(["reasoning", "tool-group"]);
    const grp = three[1];
    if (grp.kind === "tool-group") expect(grp.msgs.map((m) => m.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("reasoning between tools breaks the run — no grouping across a thought", () => {
    const items = clusterNodes([
      tool("a", "run"),
      tool("b", "run"),
      reasoning("r"),
      tool("c", "read"),
      tool("d", "read"),
      tool("e", "read"),
    ]);
    // First two tools stay inline (run of 2); the thought breaks the burst; the
    // trailing run of 3 groups.
    expect(items.map((i) => i.kind)).toEqual(["tool", "tool", "reasoning", "tool-group"]);
  });

  it("groups independent bursts independently", () => {
    const items = clusterNodes([
      tool("a", "run"),
      tool("b", "run"),
      tool("c", "run"),
      reasoning("r"),
      tool("d", "read"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool-group", "reasoning", "tool"]);
  });
});

describe("groupSummary", () => {
  const mk = (kind: Message["toolKind"]): Message => ({ id: "x", role: "tool", content: "", timestamp: "0", toolKind: kind });
  it("uses a kind-aware verb when the group is homogeneous", () => {
    expect(groupSummary([mk("read"), mk("read"), mk("read")])).toBe("Read 3 files");
    expect(groupSummary([mk("run"), mk("run"), mk("run")])).toBe("Ran 3 commands");
    expect(groupSummary([mk("write"), mk("write"), mk("write")])).toBe("Edited 3 files");
    expect(groupSummary([mk("search"), mk("search"), mk("search")])).toBe("Ran 3 searches");
  });
  it("falls back to a generic count for mixed kinds", () => {
    expect(groupSummary([mk("read"), mk("run"), mk("write")])).toBe("3 tool calls");
  });
});
