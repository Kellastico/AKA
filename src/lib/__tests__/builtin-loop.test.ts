import { describe, it, expect, vi } from "vitest";
import {
  projectContextBlock,
  parseTextToolCalls,
  runNativeToolLoop,
  runTextToolLoop,
  textProtocolSpec,
  type LoopMessage,
  type TextMessage,
} from "../builtin-loop";
import type { AssistantTurn, ToolResult } from "../tauri/commands";

/** A turn that calls one tool. */
function toolTurn(id: string, name: string, args: object): AssistantTurn {
  return {
    content: null,
    reasoning: null,
    toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

/** A turn that gives a final answer. */
function answerTurn(text: string): AssistantTurn {
  return { content: text, reasoning: null, toolCalls: [] };
}

describe("runNativeToolLoop", () => {
  it("executes a tool call, feeds the result back, and returns the final answer", async () => {
    // Turn 1: read a file. Turn 2: answer.
    const turns = [toolTurn("c1", "read_file", { path: "a.ts" }), answerTurn("It exports foo.")];
    const seen: LoopMessage[][] = [];
    const modelTurn = vi.fn(async (messages: LoopMessage[]) => {
      seen.push([...messages]);
      return turns[seen.length - 1];
    });
    const executeTool = vi.fn(
      async (): Promise<ToolResult> => ({ ok: true, content: "export const foo = 1;" }),
    );

    const started: string[] = [];
    const ended: { name: string; ok: boolean }[] = [];
    const res = await runNativeToolLoop({
      system: "sys",
      task: "what does a.ts export?",
      tools: [],
      modelTurn,
      executeTool,
      hooks: {
        onToolStart: (c) => started.push(c.name),
        onToolEnd: (e) => ended.push({ name: e.name, ok: e.ok }),
      },
    });

    expect(res).toEqual({ finalText: "It exports foo.", steps: 2, stopReason: "final" });
    expect(executeTool).toHaveBeenCalledWith("read_file", JSON.stringify({ path: "a.ts" }));
    expect(started).toEqual(["read_file"]);
    expect(ended).toEqual([{ name: "read_file", ok: true }]);

    // The 2nd turn must have seen the assistant tool-call + the tool result fed back.
    const secondTurnMessages = seen[1];
    expect(secondTurnMessages.some((m) => m.role === "assistant" && "tool_calls" in m)).toBe(true);
    const toolMsg = secondTurnMessages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ tool_call_id: "c1", content: "export const foo = 1;" });
  });

  it("stops at the step budget when the model never finishes", async () => {
    const modelTurn = vi.fn(async () => toolTurn("c", "list_dir", {}));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "." }));
    const res = await runNativeToolLoop({
      system: "s",
      task: "t",
      tools: [],
      modelTurn,
      executeTool,
      maxSteps: 3,
    });
    expect(res.stopReason).toBe("budget");
    expect(res.steps).toBe(3);
    expect(res.finalText).toBeNull();
    expect(modelTurn).toHaveBeenCalledTimes(3);
  });

  it("aborts between turns when the signal is set", async () => {
    const controller = new AbortController();
    const modelTurn = vi.fn(async () => {
      controller.abort(); // abort after the first turn's tool call
      return toolTurn("c", "read_file", { path: "x" });
    });
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "x" }));
    const res = await runNativeToolLoop({
      system: "s",
      task: "t",
      tools: [],
      modelTurn,
      executeTool,
      signal: controller.signal,
    });
    // It aborts before executing the tool of the aborted turn.
    expect(res.stopReason).toBe("aborted");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("treats an immediate answer as final with no tool calls", async () => {
    const modelTurn = vi.fn(async () => answerTurn("No tools needed."));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const onFinal = vi.fn();
    const res = await runNativeToolLoop({
      system: "s",
      task: "hi",
      tools: [],
      modelTurn,
      executeTool,
      hooks: { onFinal },
    });
    expect(res).toEqual({ finalText: "No tools needed.", steps: 1, stopReason: "final" });
    expect(executeTool).not.toHaveBeenCalled();
    expect(onFinal).toHaveBeenCalledWith("No tools needed.");
  });

  it("surfaces a failed tool result to the model and keeps going", async () => {
    // Turn 1: read a missing file (fails). Turn 2: answer anyway.
    const turns = [toolTurn("c1", "read_file", { path: "nope" }), answerTurn("That file is missing.")];
    let i = 0;
    const modelTurn = vi.fn(async () => turns[i++]);
    const executeTool = vi.fn(
      async (): Promise<ToolResult> => ({ ok: false, content: "Could not read 'nope': not found" }),
    );
    const ended: boolean[] = [];
    const res = await runNativeToolLoop({
      system: "s",
      task: "read nope",
      tools: [],
      modelTurn,
      executeTool,
      hooks: { onToolEnd: (e) => ended.push(e.ok) },
    });
    expect(ended).toEqual([false]); // the failure was surfaced, not thrown
    expect(res.finalText).toBe("That file is missing.");
  });
});

describe("parseTextToolCalls", () => {
  it("extracts call markers and keeps prose", () => {
    const { prose, calls } = parseTextToolCalls(
      'Let me look.\n@@aka {"call":"read_file","args":{"path":"a.ts"}}\n',
    );
    expect(prose).toBe("Let me look.");
    expect(calls).toEqual([
      { name: "read_file", argumentsJson: JSON.stringify({ path: "a.ts" }) },
    ]);
  });

  it("leaves malformed or non-call markers as prose", () => {
    const { prose, calls } = parseTextToolCalls(
      '@@aka {bad json}\n@@aka {"tool":"read"}\nplain text',
    );
    expect(calls).toEqual([]);
    expect(prose).toContain("plain text");
    expect(prose).toContain("@@aka {bad json}");
  });

  it("missing args default to an empty object", () => {
    const { calls } = parseTextToolCalls('@@aka {"call":"diagnostics"}');
    expect(calls).toEqual([{ name: "diagnostics", argumentsJson: "{}" }]);
  });
});

describe("runTextToolLoop", () => {
  const tools = [
    {
      type: "function",
      function: { name: "read_file", description: "Read a file.", parameters: {} },
    },
  ];

  it("teaches the protocol, executes marker calls, feeds results back as user turns", async () => {
    const turns = [
      'I will read it.\n@@aka {"call":"read_file","args":{"path":"a.ts"}}',
      "a.ts exports foo.",
    ];
    const seen: TextMessage[][] = [];
    const textTurn = vi.fn(async (messages: TextMessage[]) => {
      seen.push([...messages]);
      return turns[seen.length - 1];
    });
    const executeTool = vi.fn(
      async (): Promise<ToolResult> => ({ ok: true, content: "export const foo = 1;" }),
    );

    const res = await runTextToolLoop({
      system: "sys",
      task: "what does a.ts export?",
      tools,
      textTurn,
      executeTool,
    });

    expect(res).toEqual({ finalText: "a.ts exports foo.", steps: 2, stopReason: "final" });
    expect(executeTool).toHaveBeenCalledWith("read_file", JSON.stringify({ path: "a.ts" }));
    // The system prompt carries the protocol lesson + the tool list.
    expect(seen[0][0].content).toContain('@@aka {"call":"<tool_name>","args":{...}}');
    expect(seen[0][0].content).toContain("read_file: Read a file.");
    // The tool result went back as a user-role message (no native tool role).
    const followup = seen[1];
    const resultMsg = followup[followup.length - 1];
    expect(resultMsg.role).toBe("user");
    expect(resultMsg.content).toContain("[tool_result read_file]");
    expect(resultMsg.content).toContain("export const foo = 1;");
  });

  it("stops at the budget when the model keeps calling tools", async () => {
    const textTurn = vi.fn(async () => '@@aka {"call":"read_file","args":{"path":"a"}}');
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "x" }));
    const res = await runTextToolLoop({
      system: "s",
      task: "t",
      tools,
      textTurn,
      executeTool,
      maxSteps: 2,
    });
    expect(res.stopReason).toBe("budget");
    expect(res.steps).toBe(2);
  });

  it("a plain answer with no markers is final on turn one", async () => {
    const textTurn = vi.fn(async () => "Just an answer.");
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const res = await runTextToolLoop({ system: "s", task: "t", tools, textTurn, executeTool });
    expect(res).toEqual({ finalText: "Just an answer.", steps: 1, stopReason: "final" });
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("textProtocolSpec", () => {
  it("lists every tool by name and description", () => {
    const spec = textProtocolSpec([
      { type: "function", function: { name: "list_dir", description: "List a dir.", parameters: {} } },
    ]);
    expect(spec).toContain("list_dir: List a dir.");
    expect(spec).toContain("STOP");
  });
});

describe("projectContextBlock", () => {
  it("grounds the model with project name, root, and listing", () => {
    const block = projectContextBlock("/Users/kelly/Projects/Ikemenogo.Co", "src/\npackage.json");
    expect(block).toContain('project "Ikemenogo.Co"');
    expect(block).toContain("`/Users/kelly/Projects/Ikemenogo.Co`");
    expect(block).toContain("relative to this project root");
    expect(block).toContain("src/");
    expect(block).toContain("package.json");
  });

  it("degrades to the identity line when no listing is available", () => {
    const block = projectContextBlock("/proj/demo/", null);
    expect(block).toContain('project "demo"');
    expect(block).not.toContain("Top-level entries");
    // Empty listing behaves like null.
    expect(projectContextBlock("/proj/demo", "  ")).not.toContain("Top-level entries");
  });
});
