import { describe, expect, it } from "vitest";
import { groupRunSpans } from "../group-runs";
import type { Checkpoint } from "../../../lib/tauri/commands";

let seq = 0;
const cp = (kind: string, createdAt: number, label = kind): Checkpoint => ({
  runId: "session-1",
  seq: seq++,
  sha: `sha-${seq}`,
  label,
  kind,
  filesChanged: kind === "postrun" ? 3 : 0,
  createdAt,
});

describe("groupRunSpans", () => {
  it("returns no spans for an empty session", () => {
    expect(groupRunSpans([])).toEqual([]);
  });

  it("groups a single complete run into one span", () => {
    const spans = groupRunSpans([
      cp("prerun", 1000, "Before run"),
      cp("step", 2000),
      cp("postrun", 3000, "After run"),
    ]);
    expect(spans).toHaveLength(1);
    expect(spans[0].index).toBe(1);
    expect(spans[0].prerun?.label).toBe("Before run");
    expect(spans[0].postrun?.label).toBe("After run");
    expect(spans[0].startedAt).toBe(1000);
    expect(spans[0].checkpoints).toHaveLength(3);
  });

  it("splits multiple runs on prerun boundaries", () => {
    const spans = groupRunSpans([
      cp("prerun", 1000),
      cp("postrun", 2000),
      cp("prerun", 3000),
      cp("step", 4000),
      cp("postrun", 5000),
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[0].checkpoints).toHaveLength(2);
    expect(spans[1].checkpoints).toHaveLength(3);
    expect(spans[1].index).toBe(2);
    expect(spans[1].startedAt).toBe(3000);
  });

  it("keeps a still-running span without a postrun", () => {
    const spans = groupRunSpans([
      cp("prerun", 1000),
      cp("postrun", 2000),
      cp("prerun", 3000),
      cp("step", 4000),
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[1].postrun).toBeUndefined();
  });

  it("puts checkpoints before the first prerun into a leading span", () => {
    const spans = groupRunSpans([
      cp("manual", 500, "Manual snapshot"),
      cp("prerun", 1000),
      cp("postrun", 2000),
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[0].prerun).toBeUndefined();
    expect(spans[0].checkpoints).toHaveLength(1);
    expect(spans[0].checkpoints[0].kind).toBe("manual");
    expect(spans[1].prerun?.kind).toBe("prerun");
  });

  it("drops nothing — every checkpoint lands in exactly one span", () => {
    const input = [
      cp("manual", 500),
      cp("prerun", 1000),
      cp("step", 1500),
      cp("prerestore", 1800),
      cp("postrun", 2000),
      cp("prerun", 3000),
    ];
    const spans = groupRunSpans(input);
    const total = spans.reduce((n, s) => n + s.checkpoints.length, 0);
    expect(total).toBe(input.length);
  });
});
