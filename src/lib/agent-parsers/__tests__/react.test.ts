import { describe, it, expect } from "vitest";
import { createReActParser, isReActLine } from "../react";
import { parserForAgent } from "../index";
import type { AgentEvent } from "../types";

/** Feed every line through a parser and flatten the emitted events. */
function run(lines: string[]): AgentEvent[] {
  const p = createReActParser();
  const out: AgentEvent[] = [];
  for (const l of lines) out.push(...p.feed(l));
  out.push(...p.flush());
  return out;
}

describe("isReActLine", () => {
  it("recognises section keywords and rejects prose", () => {
    expect(isReActLine("Thought: I should look")).toBe(true);
    expect(isReActLine("Action: find_in_files")).toBe(true);
    expect(isReActLine("Action Input: {}")).toBe(true);
    expect(isReActLine("Observation: 3 matches")).toBe(true);
    expect(isReActLine("Answer: done")).toBe(true);
    expect(isReActLine("Final Answer: done")).toBe(true);
    expect(isReActLine("just regular prose")).toBe(false);
  });
});

describe("createReActParser", () => {
  it("stays dormant (passthrough) until the first keyword", () => {
    expect(run(["hello world"])).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("turns a Thought into a bounded reasoning segment", () => {
    expect(run(["Thought: I need to search the repo"])).toEqual([
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "I need to search the repo" },
      { type: "reasoning_end" },
    ]);
  });

  it("maps Action + Action Input + Observation to a tool with input + output", () => {
    const events = run([
      "Thought: search for useEffect",
      "Action: find_in_files",
      'Action Input: {"query": "useEffect", "path": "src/App.tsx"}',
      "Observation: src/App.tsx:12 useEffect(...)",
      "Thought: found it",
    ]);
    expect(events).toEqual([
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "search for useEffect" },
      { type: "reasoning_end" },
      {
        type: "tool_start",
        name: "find_in_files",
        kind: "search",
        path: "src/App.tsx",
        input: '{"query": "useEffect", "path": "src/App.tsx"}',
      },
      { type: "tool_end", ok: true, preview: "src/App.tsx:12 useEffect(...)" },
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "found it" },
      { type: "reasoning_end" },
    ]);
  });

  it("routes Answer text to the final message body, not reasoning", () => {
    const events = run([
      "Thought: I can answer",
      "Answer: I updated the effect in App.tsx.",
      "It now runs once on mount.",
    ]);
    expect(events).toEqual([
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "I can answer" },
      { type: "reasoning_end" },
      { type: "text", text: "I updated the effect in App.tsx." },
      { type: "text", text: "It now runs once on mount." },
    ]);
  });

  it("accumulates a multi-line observation into one preview", () => {
    const events = run([
      "Action: read_file",
      'Action Input: {"path": "a.ts"}',
      "Observation: line one",
      "line two",
      "Answer: done",
    ]);
    expect(events).toEqual([
      {
        type: "tool_start",
        name: "read_file",
        kind: "read",
        path: "a.ts",
        input: '{"path": "a.ts"}',
      },
      { type: "tool_end", ok: true, preview: "line one line two" },
      { type: "text", text: "done" },
    ]);
  });

  it("catches an Action written mid-line after the Thought (no newline)", () => {
    // Real-world: the model ends its reasoning and starts the Action on the
    // same line — "…project structure.Action: list_directory".
    const events = run([
      "Thought: I'll list the files to see the project structure.Action: list_directory",
      "Observation: 42 entries",
      "Thought: done",
      "Answer: there are 42 files",
    ]);
    expect(events).toEqual([
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "I'll list the files to see the project structure." },
      { type: "reasoning_end" },
      { type: "tool_start", name: "list_directory", kind: "search" },
      { type: "tool_end", ok: true, preview: "42 entries" },
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "done" },
      { type: "reasoning_end" },
      { type: "text", text: "there are 42 files" },
    ]);
    // The tool carries a real name — not the generic "tool" fallback.
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ name: "list_directory" });
  });

  it("does not split keyword-like text inside an observation", () => {
    const events = run([
      "Action: grep",
      'Action Input: {"q":"x"}',
      "Observation: match at App.tsx: dispatch(Action: RESET)",
      "Answer: found it",
    ]);
    // The observation keeps its full text; no spurious tool/thought is created.
    const tools = events.filter((e) => e.type === "tool_start");
    expect(tools).toHaveLength(1);
    const end = events.find((e) => e.type === "tool_end") as { preview?: string };
    expect(end.preview).toContain("dispatch(Action: RESET)");
  });

  it("closes a dangling Thought on flush", () => {
    expect(run(["Thought: thinking out loud"])).toEqual([
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "thinking out loud" },
      { type: "reasoning_end" },
    ]);
  });
});

describe("no scaffolding leaks (acceptance)", () => {
  // A realistic LlamaIndex ReActAgent transcript, streamed line by line.
  const transcript = [
    "Thought: The user wants the useEffect cleaned up. I should find it first.",
    "Action: find_in_files",
    'Action Input: {"query": "useEffect", "path": "src/App.tsx"}',
    "Observation: src/App.tsx:12: useEffect(() => {...}, [])",
    "Thought: Found it. Now I'll edit the file.",
    "Action: edit_file",
    'Action Input: {"path": "src/App.tsx", "patch": "..."}',
    "Observation: Edited src/App.tsx",
    "Thought: I can answer now.",
    "Answer: I cleaned up the useEffect in src/App.tsx — it now runs once on mount.",
  ];

  it("interleaves reasoning + tools and never leaks raw Action:/Observation: prose", () => {
    const p = parserForAgent("/Users/me/agents/anya");
    const events: AgentEvent[] = [];
    for (const line of transcript) events.push(...p.feed(line));
    events.push(...p.flush());

    // The sequence interleaves reasoning and tools, ending in the answer.
    const shape = events.map((e) => e.type);
    expect(shape).toEqual([
      "reasoning_start",
      "reasoning_delta",
      "reasoning_end",
      "tool_start",
      "tool_end",
      "reasoning_start",
      "reasoning_delta",
      "reasoning_end",
      "tool_start",
      "tool_end",
      "reasoning_start",
      "reasoning_delta",
      "reasoning_end",
      "text",
    ]);

    // Critically: no text event carries raw ReAct scaffolding.
    const leaked = events
      .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
      .filter((e) => /^\s*(Thought|Action|Action Input|Observation)\s*:/i.test(e.text));
    expect(leaked).toEqual([]);

    // The two tools are structured with readable input + a clean kind.
    const tools = events.filter((e) => e.type === "tool_start");
    expect(tools).toEqual([
      expect.objectContaining({ name: "find_in_files", kind: "search", path: "src/App.tsx" }),
      expect.objectContaining({ name: "edit_file", kind: "write", path: "src/App.tsx" }),
    ]);

    // The only user-facing body text is the final answer.
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text);
    expect(text).toEqual([
      "I cleaned up the useEffect in src/App.tsx — it now runs once on mount.",
    ]);
  });
});

describe("parserForAgent wiring", () => {
  it("gives a non-smallcode agent the ReAct parser while prose still passes", () => {
    const p = parserForAgent("python3");
    expect(p.feed("plain reply")).toEqual([{ type: "text", text: "plain reply" }]);
    expect(p.feed("Thought: hmm")).toEqual([
      { type: "reasoning_start" },
      { type: "reasoning_delta", text: "hmm" },
    ]);
  });

  it("still parses @@aka markers in front of the ReAct base parser", () => {
    const p = parserForAgent("python3");
    expect(p.feed('@@aka {"tool":"read","path":"a.py"}')).toEqual([
      { type: "tool_start", name: "read", kind: "read", path: "a.py" },
      { type: "tool_end", ok: true, path: "a.py" },
    ]);
  });
});
