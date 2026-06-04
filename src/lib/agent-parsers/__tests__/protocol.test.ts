import { describe, it, expect } from "vitest";
import { createProtocolParser, isAkaMarker } from "../protocol";
import { composeParsers, parserForAgent } from "../index";
import type { AgentParser } from "../types";

describe("isAkaMarker", () => {
  it("recognises marker lines and rejects prose", () => {
    expect(isAkaMarker('@@aka {"tool":"read","path":"a.ts"}')).toBe(true);
    expect(isAkaMarker('  @@aka {"tool":"run"}')).toBe(true);
    expect(isAkaMarker("Reading some file")).toBe(false);
    expect(isAkaMarker("@@aka not-json")).toBe(false);
  });
});

describe("createProtocolParser", () => {
  it("emits a paired tool_start + tool_end for a one-line marker", () => {
    const p = createProtocolParser();
    const events = p.feed('@@aka {"tool":"read","path":"src/App.jsx"}');
    expect(events).toEqual([
      { type: "tool_start", name: "read", kind: "read", path: "src/App.jsx" },
      { type: "tool_end", ok: true, path: "src/App.jsx" },
    ]);
  });

  it("carries metadata (name, preview, ms, line counts, ok=false)", () => {
    const p = createProtocolParser();
    const events = p.feed(
      '@@aka {"tool":"write","name":"edit_file","path":"x.ts","preview":"patch","ms":12,"linesAdded":4,"linesRemoved":2,"ok":false}',
    );
    expect(events).toEqual([
      { type: "tool_start", name: "edit_file", kind: "write", path: "x.ts" },
      {
        type: "tool_end",
        ok: false,
        elapsedMs: 12,
        preview: "patch",
        path: "x.ts",
        linesAdded: 4,
        linesRemoved: 2,
      },
    ]);
  });

  it("supports split start/end phases", () => {
    const p = createProtocolParser();
    expect(p.feed('@@aka {"tool":"run","name":"bash","phase":"start"}')).toEqual([
      { type: "tool_start", name: "bash", kind: "run" },
    ]);
    expect(p.feed('@@aka {"tool":"run","phase":"end","ok":true,"ms":840}')).toEqual([
      { type: "tool_end", ok: true, elapsedMs: 840 },
    ]);
  });

  it("maps unknown tool kinds to run and drops malformed JSON", () => {
    const p = createProtocolParser();
    expect(p.feed('@@aka {"tool":"frobnicate","name":"x"}')[0]).toMatchObject({
      type: "tool_start",
      kind: "run",
    });
    expect(p.feed("@@aka {bad json}")).toEqual([]);
  });
});

describe("composeParsers / parserForAgent", () => {
  const textParser: AgentParser = {
    feed: (line) => [{ type: "text", text: line }],
    flush: () => [],
  };

  it("routes markers to the protocol parser and prose to the base parser", () => {
    const p = composeParsers(createProtocolParser(), textParser, isAkaMarker);
    expect(p.feed('@@aka {"tool":"search","name":"grep"}')).toEqual([
      { type: "tool_start", name: "grep", kind: "search" },
      { type: "tool_end", ok: true },
    ]);
    expect(p.feed("just talking")).toEqual([{ type: "text", text: "just talking" }]);
  });

  it("gives EVERY agent the protocol (not just smallcode)", () => {
    // A generic python agent still parses @@aka markers into tool events.
    const p = parserForAgent("python3");
    expect(p.feed('@@aka {"tool":"read","path":"a.py"}')).toEqual([
      { type: "tool_start", name: "read", kind: "read", path: "a.py" },
      { type: "tool_end", ok: true, path: "a.py" },
    ]);
    // …and non-marker prose still passes through as text.
    expect(p.feed("hello")).toEqual([{ type: "text", text: "hello" }]);
  });
});
