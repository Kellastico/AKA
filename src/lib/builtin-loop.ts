import type { AssistantTurn, ToolCall, ToolDef, ToolResult } from "./tauri/commands";

/**
 * The provider-agnostic core of AKA's built-in agent loop — the thing that turns
 * "None + Strategize" (and, later, Execute) into a real tool-using model.
 *
 * It is intentionally decoupled from both the chat store and any specific
 * provider: the caller injects `modelTurn` (one native tool-calling turn — today
 * `callLlmTools`, tomorrow a provider adapter) and `executeTool` (the enforced
 * `executeBuiltinTool` chokepoint). This module only owns the *loop*: feed the
 * model, run the tool calls it asks for, append the results, repeat until it
 * answers or the step budget is hit. That makes the loop's correctness unit-
 * testable with plain mocks — no network, no Tauri.
 *
 * The tools the model may call are supplied by the caller and are **phase-gated
 * upstream** (`builtinToolDefs("readonly")` for Strategize), so read-only mode
 * physically cannot include a write/exec tool. This module enforces nothing about
 * privilege itself — that lives in the host executor — it just drives the turns.
 */

/** One native tool-calling turn: the model either calls tools or gives an answer. */
export type ModelTurn = (messages: LoopMessage[]) => Promise<AssistantTurn>;

/** Execute one model-chosen tool call through the enforced host chokepoint. */
export type ExecuteTool = (name: string, argumentsJson: string) => Promise<ToolResult>;

/** Raw OpenAI-shaped message objects the loop threads back to the model. */
export type LoopMessage = Record<string, unknown>;

/** Observability hooks so the caller can render the witness timeline as it runs. */
export type LoopHooks = {
  onReasoning?: (text: string) => void;
  onToolStart?: (call: { name: string; argumentsJson: string }) => void;
  onToolEnd?: (result: { name: string; ok: boolean; content: string }) => void;
  onFinal?: (text: string) => void;
};

export type LoopOptions = {
  /** System prompt (task envelope + tool guidance), prepended once. */
  system: string;
  /** The user's task. */
  task: string;
  /** The tools the model may call this run (already phase-gated). */
  tools: ToolDef[];
  modelTurn: ModelTurn;
  executeTool: ExecuteTool;
  hooks?: LoopHooks;
  /** Hard cap on model turns, so a confused model can't loop forever. */
  maxSteps?: number;
  /** Cooperative cancellation — checked between turns and tool calls. */
  signal?: AbortSignal;
};

export type LoopResult = {
  /** The model's final answer, or `null` if it never produced one. */
  finalText: string | null;
  /** Model turns taken. */
  steps: number;
  /** Why the loop ended. */
  stopReason: "final" | "budget" | "aborted" | "no-progress";
};

const DEFAULT_MAX_STEPS = 16;

/** Build the assistant message that records the tool calls the model made. */
function assistantToolCallMessage(turn: AssistantTurn): LoopMessage {
  return {
    role: "assistant",
    content: turn.content ?? "",
    tool_calls: turn.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.function.name, arguments: c.function.arguments },
    })),
  };
}

/** Build the `tool` result message the model reads on the next turn. */
function toolResultMessage(call: ToolCall, result: ToolResult): LoopMessage {
  return {
    role: "tool",
    tool_call_id: call.id,
    content: result.content,
  };
}

const aborted = (signal?: AbortSignal) => signal?.aborted === true;

/**
 * Run the native tool-calling loop to completion. Each turn: ask the model; if it
 * returned tool calls, execute every one through `executeTool`, append the
 * results, and loop; otherwise its `content` is the final answer. Terminates on a
 * final answer, the step budget, cancellation, or a turn that produced neither a
 * tool call nor an answer (no progress → treat the last content as the answer).
 */
export async function runNativeToolLoop(opts: LoopOptions): Promise<LoopResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages: LoopMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];

  let steps = 0;
  while (steps < maxSteps) {
    if (aborted(opts.signal)) return { finalText: null, steps, stopReason: "aborted" };
    steps += 1;

    const turn = await opts.modelTurn(messages);
    if (turn.reasoning && opts.hooks?.onReasoning) opts.hooks.onReasoning(turn.reasoning);

    // No tool calls → the model is done (or gave up). Its content is the answer.
    if (turn.toolCalls.length === 0) {
      const finalText = turn.content ?? "";
      opts.hooks?.onFinal?.(finalText);
      return {
        finalText: finalText.length > 0 ? finalText : null,
        steps,
        stopReason: turn.content != null ? "final" : "no-progress",
      };
    }

    // Record the assistant's tool-call turn, then run each call in order.
    messages.push(assistantToolCallMessage(turn));
    for (const call of turn.toolCalls) {
      if (aborted(opts.signal)) return { finalText: null, steps, stopReason: "aborted" };
      const argumentsJson = call.function.arguments || "{}";
      opts.hooks?.onToolStart?.({ name: call.function.name, argumentsJson });
      const result = await opts.executeTool(call.function.name, argumentsJson);
      opts.hooks?.onToolEnd?.({
        name: call.function.name,
        ok: result.ok,
        content: result.content,
      });
      messages.push(toolResultMessage(call, result));
    }
  }

  return { finalText: null, steps, stopReason: "budget" };
}

// ---------- Project grounding ----------

/**
 * The project-context block prepended to the loop's system prompt so the model
 * knows WHERE it is from turn one — without this it starts blind (no project
 * name, no root, no idea what files exist) and wastes turns or asks the user.
 * `listing` is the project root's top-level entries (from the same enforced
 * `list_dir` tool the model uses); pass `null` when unavailable and the block
 * degrades to just the identity line.
 */
export function projectContextBlock(
  projectPath: string,
  listing: string | null,
): string {
  const name = projectPath.replace(/\/+$/, "").split("/").pop() || projectPath;
  const lines = [
    "## Project",
    `You are working inside the project "${name}" at \`${projectPath}\`.`,
    "All tool paths are relative to this project root.",
  ];
  if (listing && listing.trim()) {
    lines.push("", "Top-level entries (directories end with /):", listing.trim());
  }
  return lines.join("\n");
}

// ---------- Text-protocol fallback (models without native tool-calling) ----------

/**
 * One plain-text model turn for the fallback path: full message history in,
 * completed response text out (non-streamed — a tool turn has no streaming value,
 * and marker parsing needs the whole response). Wraps `callLlm` at the call site.
 */
export type TextTurn = (messages: TextMessage[]) => Promise<string>;

export type TextMessage = { role: "system" | "user" | "assistant"; content: string };

/** A tool call extracted from an `@@aka {"call":…}` marker line. */
export type ParsedCall = { name: string; argumentsJson: string };

/** Marker shape the fallback prompt teaches: `@@aka {"call":"read_file","args":{…}}`. */
const CALL_MARKER_RE = /^\s*@@aka\s+(\{.*\})\s*$/;

/**
 * Split a fallback response into prose + tool calls. Lines matching the
 * `@@aka {"call":…}` marker become calls; everything else stays prose (the
 * model's visible reasoning). Malformed or non-call markers are left as prose so
 * nothing is silently swallowed.
 */
export function parseTextToolCalls(response: string): {
  prose: string;
  calls: ParsedCall[];
} {
  const proseLines: string[] = [];
  const calls: ParsedCall[] = [];
  for (const line of response.split("\n")) {
    const m = line.match(CALL_MARKER_RE);
    if (m) {
      try {
        const j = JSON.parse(m[1]) as { call?: string; args?: unknown };
        if (typeof j.call === "string" && j.call.length > 0) {
          calls.push({
            name: j.call,
            argumentsJson: JSON.stringify(j.args ?? {}),
          });
          continue;
        }
      } catch {
        // fall through — keep the line as prose
      }
    }
    proseLines.push(line);
  }
  return { prose: proseLines.join("\n").trim(), calls };
}

/**
 * The protocol lesson appended to the system prompt on the fallback path: how to
 * request a tool with a marker line. Kept short — small models lose long specs.
 */
export function textProtocolSpec(tools: ToolDef[]): string {
  const list = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join("\n");
  return [
    "You can use tools by writing a line in EXACTLY this form (one per line, nothing else on the line):",
    '@@aka {"call":"<tool_name>","args":{...}}',
    "",
    "Available tools:",
    list,
    "",
    'Example: @@aka {"call":"read_file","args":{"path":"src/main.ts"}}',
    "After you write a tool line, STOP — the result will be sent to you in the next message.",
    "When you have enough information, answer normally with no tool line.",
  ].join("\n");
}

/**
 * Drive the tool loop over plain text for models without native tool-calling:
 * teach the marker protocol in the system prompt, parse `@@aka {"call":…}` lines
 * out of each response, execute them through the same enforced chokepoint, and
 * feed results back as user-role messages (`tool` role needs native tool_calls
 * support, which is exactly what these models lack). Same hooks, same result
 * shape, same enforcement as the native loop — only the transport differs.
 */
export async function runTextToolLoop(
  opts: Omit<LoopOptions, "modelTurn"> & { textTurn: TextTurn },
): Promise<LoopResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages: TextMessage[] = [
    { role: "system", content: `${opts.system}\n\n${textProtocolSpec(opts.tools)}` },
    { role: "user", content: opts.task },
  ];

  let steps = 0;
  while (steps < maxSteps) {
    if (aborted(opts.signal)) return { finalText: null, steps, stopReason: "aborted" };
    steps += 1;

    const response = await opts.textTurn(messages);
    const { prose, calls } = parseTextToolCalls(response);
    if (prose && opts.hooks?.onReasoning && calls.length > 0) {
      // Mid-loop prose is working commentary, not the final answer.
      opts.hooks.onReasoning(prose);
    }

    if (calls.length === 0) {
      const finalText = prose;
      opts.hooks?.onFinal?.(finalText);
      return {
        finalText: finalText.length > 0 ? finalText : null,
        steps,
        stopReason: finalText.length > 0 ? "final" : "no-progress",
      };
    }

    messages.push({ role: "assistant", content: response });
    const results: string[] = [];
    for (const call of calls) {
      if (aborted(opts.signal)) return { finalText: null, steps, stopReason: "aborted" };
      opts.hooks?.onToolStart?.({ name: call.name, argumentsJson: call.argumentsJson });
      const result = await opts.executeTool(call.name, call.argumentsJson);
      opts.hooks?.onToolEnd?.({ name: call.name, ok: result.ok, content: result.content });
      results.push(`[tool_result ${call.name}${result.ok ? "" : " (error)"}]\n${result.content}`);
    }
    messages.push({ role: "user", content: results.join("\n\n") });
  }

  return { finalText: null, steps, stopReason: "budget" };
}
