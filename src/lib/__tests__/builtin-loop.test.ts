import { describe, it, expect, vi } from "vitest";
import {
  projectContextBlock,
  parseTextToolCalls,
  runAdaptiveToolLoop,
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

/** An empty turn — the intermittent local-model hiccup (no content, no calls). */
function emptyTurn(): AssistantTurn {
  return { content: "", reasoning: null, toolCalls: [] };
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

  it("retries an empty turn and recovers when the next attempt answers", async () => {
    // Model returns nothing twice (transient hiccup), then a real answer.
    const turns = [emptyTurn(), emptyTurn(), answerTurn("Recovered.")];
    let i = 0;
    const modelTurn = vi.fn(async () => turns[i++]);
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const onEmptyRetry = vi.fn();
    const res = await runNativeToolLoop({
      system: "s",
      task: "t",
      tools: [],
      modelTurn,
      executeTool,
      hooks: { onEmptyRetry },
    });
    expect(res.finalText).toBe("Recovered.");
    expect(res.stopReason).toBe("final");
    expect(modelTurn).toHaveBeenCalledTimes(3); // two empties + the answer
    expect(onEmptyRetry).toHaveBeenCalledTimes(2);
  });

  it("gives up with stopReason 'empty' when every retry stays blank", async () => {
    const modelTurn = vi.fn(async () => emptyTurn());
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const res = await runNativeToolLoop({
      system: "s",
      task: "t",
      tools: [],
      modelTurn,
      executeTool,
      emptyRetries: 3,
    });
    expect(res.finalText).toBeNull();
    expect(res.stopReason).toBe("empty");
    // One turn on step 1 (steps=1), retried 3 times = 4 calls total.
    expect(modelTurn).toHaveBeenCalledTimes(4);
    expect(res.steps).toBe(1);
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

  it("parses a marker inline after prose on the same line", () => {
    const { prose, calls } = parseTextToolCalls(
      'Let me check the config.@@aka {"call":"read_file","args":{"path":"vite.config.mjs"}}',
    );
    expect(prose).toBe("Let me check the config.");
    expect(calls).toEqual([
      { name: "read_file", argumentsJson: JSON.stringify({ path: "vite.config.mjs" }) },
    ]);
  });

  it("parses several markers concatenated on one line (real model output)", () => {
    // Verbatim shape observed from a local model: prose then three back-to-back calls.
    const { prose, calls } = parseTextToolCalls(
      "I'll investigate your server configuration." +
        '@@aka {"call":"read_file","args":{"path":"vite.config.mjs"}}' +
        '@@aka {"call":"read_file","args":{"path":"package.json"}}' +
        '@@aka {"call":"search_files","args":{"pattern":"server"}}',
    );
    expect(prose).toBe("I'll investigate your server configuration.");
    expect(calls.map((c) => c.name)).toEqual(["read_file", "read_file", "search_files"]);
    expect(calls[2].argumentsJson).toBe(JSON.stringify({ pattern: "server" }));
  });

  it("parses JSON that spans multiple lines with raw newlines inside strings", () => {
    // str_replace payloads carry multi-line code — models write the newlines
    // literally (invalid JSON) rather than as \n escapes. The repair pass fixes it.
    const marker =
      '@@aka {"call":"str_replace","args":{"path":"index.html","old_str":"<!-- Footer-->\n<div>\n</div>","new_str":"<footer class=\\"bg-black\\">\n</footer>"}}';
    const { prose, calls } = parseTextToolCalls(marker);
    expect(prose).toBe("");
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].argumentsJson) as Record<string, string>;
    expect(args.path).toBe("index.html");
    expect(args.old_str).toBe("<!-- Footer-->\n<div>\n</div>");
    expect(args.new_str).toBe('<footer class="bg-black">\n</footer>');
  });

  it("keeps a truncated (unbalanced) marker as prose", () => {
    const { prose, calls } = parseTextToolCalls(
      'cut off: @@aka {"call":"read_file","args":{"path":"a.ts"',
    );
    expect(calls).toEqual([]);
    expect(prose).toContain('@@aka {"call":"read_file"');
  });

  it("a bare @@aka with no object stays prose", () => {
    const { prose, calls } = parseTextToolCalls("the @@aka protocol is neat");
    expect(calls).toEqual([]);
    expect(prose).toBe("the @@aka protocol is neat");
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

  it("retries an empty (whitespace-only) response and recovers", async () => {
    // "" then "   " (both blank), then a real marker call, then the answer.
    const responses = ["", "   ", '@@aka {"call":"read_file","args":{"path":"a.ts"}}', "Done."];
    let i = 0;
    const textTurn = vi.fn(async () => responses[i++]);
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "ok" }));
    const onEmptyRetry = vi.fn();
    const res = await runTextToolLoop({
      system: "s",
      task: "t",
      tools,
      textTurn,
      executeTool,
      hooks: { onEmptyRetry },
    });
    expect(res.finalText).toBe("Done.");
    expect(onEmptyRetry).toHaveBeenCalledTimes(2); // the "" and the "   "
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("gives up with stopReason 'empty' when the model only ever returns blanks", async () => {
    const textTurn = vi.fn(async () => "");
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const res = await runTextToolLoop({
      system: "s",
      task: "t",
      tools,
      textTurn,
      executeTool,
      emptyRetries: 2,
    });
    expect(res.finalText).toBeNull();
    expect(res.stopReason).toBe("empty");
    expect(textTurn).toHaveBeenCalledTimes(3); // initial + 2 retries
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

describe("runAdaptiveToolLoop", () => {
  const tools = [
    {
      type: "function",
      function: { name: "read_file", description: "Read a file.", parameters: {} },
    },
  ];
  /** Error shaped like a 400 ProviderRejected — "endpoint can't take tools". */
  const rejects400 = { kind: "ProviderRejected", status: 400, message: "does not support tools" };
  const isToolsUnsupported = (err: unknown) =>
    (err as { status?: number })?.status === 400;

  it("stays native when the endpoint accepts tools; text path never runs", async () => {
    const modelTurn = vi.fn(async () => answerTurn("Native answer."));
    const textTurn = vi.fn(async () => "unused");
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const res = await runAdaptiveToolLoop({
      system: "s", task: "t", tools, startNative: true,
      modelTurn, textTurn, isToolsUnsupported, executeTool,
    });
    expect(res.transport).toBe("native");
    expect(res.finalText).toBe("Native answer.");
    expect(textTurn).not.toHaveBeenCalled();
  });

  it("falls back to the text protocol when the first native turn is rejected", async () => {
    const modelTurn = vi.fn(async () => { throw rejects400; });
    const textTurn = vi.fn(async () => "Text answer.");
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const onTransportFallback = vi.fn();
    const res = await runAdaptiveToolLoop({
      system: "s", task: "t", tools, startNative: true,
      modelTurn, textTurn, isToolsUnsupported, onTransportFallback, executeTool,
    });
    expect(res.transport).toBe("text");
    expect(res.finalText).toBe("Text answer.");
    expect(onTransportFallback).toHaveBeenCalledTimes(1);
    expect(modelTurn).toHaveBeenCalledTimes(1);
  });

  it("skips the native attempt entirely when evidence already says text", async () => {
    const modelTurn = vi.fn(async () => answerTurn("never"));
    const textTurn = vi.fn(async () => "Straight to text.");
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    const res = await runAdaptiveToolLoop({
      system: "s", task: "t", tools, startNative: false,
      modelTurn, textTurn, isToolsUnsupported, executeTool,
    });
    expect(res.transport).toBe("text");
    expect(modelTurn).not.toHaveBeenCalled();
  });

  it("propagates unclassified errors instead of falling back", async () => {
    const authError = { kind: "ProviderRejected", status: 401, message: "bad key" };
    const modelTurn = vi.fn(async () => { throw authError; });
    const textTurn = vi.fn(async () => "unused");
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "" }));
    await expect(
      runAdaptiveToolLoop({
        system: "s", task: "t", tools, startNative: true,
        modelTurn, textTurn, isToolsUnsupported, executeTool,
      }),
    ).rejects.toBe(authError);
    expect(textTurn).not.toHaveBeenCalled();
  });

  it("never downgrades mid-run: a 400 AFTER a successful native turn propagates", async () => {
    // Turn 1 calls a tool (native works); turn 2 throws a 400 — that's a real
    // error now, not a capability signal.
    const turns = [toolTurn("c1", "read_file", { path: "a.ts" })];
    let i = 0;
    const modelTurn = vi.fn(async () => {
      if (i < turns.length) return turns[i++];
      throw rejects400;
    });
    const textTurn = vi.fn(async () => "unused");
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ ok: true, content: "data" }));
    await expect(
      runAdaptiveToolLoop({
        system: "s", task: "t", tools, startNative: true,
        modelTurn, textTurn, isToolsUnsupported, executeTool,
      }),
    ).rejects.toBe(rejects400);
    expect(textTurn).not.toHaveBeenCalled();
  });
});
