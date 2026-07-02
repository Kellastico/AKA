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

  it("emits a context event for a live usage marker (not a tool card)", () => {
    const p = createProtocolParser();
    expect(
      p.feed('@@aka {"event":"context","used_tokens":25000,"context_window":32768}'),
    ).toEqual([{ type: "context", usedTokens: 25000, contextWindow: 32768 }]);
  });

  it("tolerates a context marker with a missing/invalid window (0)", () => {
    const p = createProtocolParser();
    expect(p.feed('@@aka {"event":"context","used_tokens":900}')).toEqual([
      { type: "context", usedTokens: 900, contextWindow: 0 },
    ]);
    // No usable used_tokens → consumed silently, never a card.
    expect(p.feed('@@aka {"event":"context","context_window":32768}')).toEqual([]);
  });

  it("parses a dev-server control marker as a control event", () => {
    const p = createProtocolParser();
    expect(
      p.feed('@@aka {"control":"dev_server","action":"restart"}'),
    ).toEqual([{ type: "control", target: "dev_server", action: "restart" }]);
    // Missing action defaults to empty string, not undefined.
    expect(p.feed('@@aka {"control":"dev_server"}')).toEqual([
      { type: "control", target: "dev_server", action: "" },
    ]);
    // It is control-plane: never a tool row.
    const ev = p.feed('@@aka {"control":"dev_server","action":"kill"}');
    expect(ev.every((e) => e.type === "control")).toBe(true);
  });

  it("parses a host witness card, carrying the recorded hash + line range", () => {
    // The exact shape `execution_witness::witness_card_line` emits after a real
    // on-disk edit — renders as a write card with the recorded diff evidence.
    const p = createProtocolParser();
    const events = p.feed(
      '@@aka {"tool":"write","name":"witness","path":"src/a.rs","linesAdded":1,"linesRemoved":1,"hash":"abc123","ok":true}',
    );
    expect(events).toEqual([
      { type: "tool_start", name: "witness", kind: "write", path: "src/a.rs" },
      {
        type: "tool_end",
        ok: true,
        path: "src/a.rs",
        linesAdded: 1,
        linesRemoved: 1,
        hash: "abc123",
      },
    ]);
  });

  it("parses a host denial card as a failed tool card with a reason", () => {
    // What `denial_card_line` emits when a gate blocks a write/delete.
    const p = createProtocolParser();
    const events = p.feed(
      '@@aka {"tool":"write","name":"delete_file","ok":false,"preview":"denied: unapproved delete: a.txt"}',
    );
    expect(events[0]).toMatchObject({ type: "tool_start", name: "delete_file", kind: "write" });
    expect(events[1]).toMatchObject({
      type: "tool_end",
      ok: false,
      preview: "denied: unapproved delete: a.txt",
    });
  });

  it("surfaces an in-band capability announcement as a capabilities event", () => {
    const p = createProtocolParser();
    const events = p.feed(
      '@@aka {"announce":"capability-contract","name":"Änyä","manages_llm":true,"supports_streaming":true,"capability-contract":"v1","capability_folders":["read","write"]}',
    );
    expect(events).toEqual([
      {
        type: "capabilities",
        probe: {
          type: "agent",
          name: "Änyä",
          manages_llm: true,
          supports_streaming: true,
          supports_dry_run: false,
          required_args: [],
          "capability-contract": "v1",
          capability_folders: ["read", "write"],
        },
      },
    ]);
    // It is control-plane: never a tool row, never chat prose.
    expect(events.every((e) => e.type === "capabilities")).toBe(true);
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
