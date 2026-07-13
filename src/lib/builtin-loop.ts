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
  /**
   * A model turn came back empty (no content, no tool call) and the loop is
   * re-asking. `attempt` is the 1-based retry number. Lets the caller surface
   * "the model returned nothing — retrying" instead of a silent pause.
   */
  onEmptyRetry?: (attempt: number) => void;
  /**
   * Estimated prompt size (tokens ≈ serialized chars / 4) reported before every
   * model turn. The loop's REAL history — tool results included — is invisible
   * to the transcript-based meter, so this is what keeps the context meter
   * honest during a run, especially on small-context local models.
   */
  onUsage?: (estimatedTokens: number) => void;
};

/** Whether a string is absent or only whitespace. */
function isBlank(s: string | null | undefined): boolean {
  return s == null || s.trim().length === 0;
}

/** Rough wire-size estimate of a message array: serialized chars / 4. */
function estimateTokens(messages: unknown[]): number {
  try {
    return Math.round(JSON.stringify(messages).length / 4);
  } catch {
    return 0;
  }
}

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
  /**
   * How many times to re-ask a single turn that came back empty (no content,
   * no tool call) before treating it as terminal. A local model can return an
   * empty completion intermittently — a transient decode hiccup, not an answer
   * — so one blank response should not kill the run. Defaults to
   * {@link DEFAULT_EMPTY_RETRIES}; set 0 to disable.
   */
  emptyRetries?: number;
  /** Cooperative cancellation — checked between turns and tool calls. */
  signal?: AbortSignal;
};

export type LoopResult = {
  /** The model's final answer, or `null` if it never produced one. */
  finalText: string | null;
  /** Model turns taken. */
  steps: number;
  /**
   * Why the loop ended. `empty` = the model kept returning nothing even after
   * retries (distinct from `no-progress`, which is a clean but answerless stop).
   */
  stopReason: "final" | "budget" | "aborted" | "no-progress" | "empty";
};

const DEFAULT_MAX_STEPS = 16;
/** Default empty-turn re-asks (see {@link LoopOptions.emptyRetries}). */
const DEFAULT_EMPTY_RETRIES = 3;

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
  const emptyRetries = opts.emptyRetries ?? DEFAULT_EMPTY_RETRIES;
  const messages: LoopMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];

  let steps = 0;
  while (steps < maxSteps) {
    if (aborted(opts.signal)) return { finalText: null, steps, stopReason: "aborted" };
    steps += 1;

    opts.hooks?.onUsage?.(estimateTokens(messages));
    // Re-ask a turn that comes back empty (no content, no tool call): a local
    // model can return a blank completion intermittently, and giving up on the
    // first one would strand the run with "no answer" even though the very next
    // attempt usually succeeds.
    let turn = await opts.modelTurn(messages);
    for (
      let attempt = 1;
      attempt <= emptyRetries &&
      turn.toolCalls.length === 0 &&
      isBlank(turn.content) &&
      !aborted(opts.signal);
      attempt += 1
    ) {
      opts.hooks?.onEmptyRetry?.(attempt);
      turn = await opts.modelTurn(messages);
    }
    if (turn.reasoning && opts.hooks?.onReasoning) opts.hooks.onReasoning(turn.reasoning);

    // No tool calls → the model is done, gave up, or kept coming back empty.
    if (turn.toolCalls.length === 0) {
      const finalText = (turn.content ?? "").trim();
      opts.hooks?.onFinal?.(finalText);
      return {
        finalText: finalText.length > 0 ? finalText : null,
        steps,
        // A non-blank answer is a clean finish; a still-blank turn after retries
        // is an `empty` stop the caller can explain more helpfully.
        stopReason: finalText.length > 0 ? "final" : "empty",
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

/** A tool call extracted from an `@@aka {"call":…}` marker. */
export type ParsedCall = { name: string; argumentsJson: string };

/** The sentinel the fallback prompt teaches: `@@aka {"call":…,"args":{…}}`. */
const CALL_MARKER = "@@aka";

/**
 * From `start` (which must point at a `{`), scan a balanced JSON object.
 * String-aware — braces inside string literals don't count — and tolerant of
 * raw newlines inside strings (models emit those; the repair pass below makes
 * them parseable). Returns the object's source text and the index just past
 * it, or `null` when the braces never balance (a truncated marker).
 */
function scanJsonObject(
  text: string,
  start: number,
): { json: string; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Escape raw control characters inside JSON string literals (`\n`/`\r`/`\t`
 * written literally instead of escaped). Small models routinely emit real
 * newlines inside `old_str`/`new_str`/`patch` payloads — strictly invalid
 * JSON, but unambiguous — so repairing beats dropping the call.
 */
function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** Parse a marker's JSON, retrying once with control-char repair. */
function parseMarkerJson(json: string): { call?: unknown; args?: unknown } | null {
  for (const candidate of [json, escapeControlCharsInStrings(json)]) {
    try {
      const j: unknown = JSON.parse(candidate);
      if (j && typeof j === "object") return j as { call?: unknown; args?: unknown };
    } catch {
      /* try the repaired form */
    }
  }
  return null;
}

/**
 * Split a fallback response into prose + tool calls. LENIENT on purpose: the
 * prompt teaches "one marker per line", but real models emit markers inline
 * after prose, several concatenated on one line, and JSON spanning multiple
 * lines (raw newlines inside `old_str`/`patch` strings). All of those parse —
 * a capable model's tool use must render and execute exactly like an agent's,
 * not fall through as raw text. Everything that isn't a valid `@@aka
 * {"call":…}` object stays prose, so nothing is silently swallowed.
 */
export function parseTextToolCalls(response: string): {
  prose: string;
  calls: ParsedCall[];
} {
  const calls: ParsedCall[] = [];
  let prose = "";
  let cursor = 0;
  for (;;) {
    const at = response.indexOf(CALL_MARKER, cursor);
    if (at === -1) {
      prose += response.slice(cursor);
      break;
    }
    // Find the payload `{` (allow spaces/tabs after the sentinel).
    let braceAt = at + CALL_MARKER.length;
    while (response[braceAt] === " " || response[braceAt] === "\t") braceAt += 1;
    if (response[braceAt] !== "{") {
      // A bare "@@aka" with no object — prose, keep going past it.
      prose += response.slice(cursor, at + CALL_MARKER.length);
      cursor = at + CALL_MARKER.length;
      continue;
    }
    const scanned = scanJsonObject(response, braceAt);
    if (!scanned) {
      // Unbalanced to the end of the response (truncated output) — prose.
      prose += response.slice(cursor);
      break;
    }
    const j = parseMarkerJson(scanned.json);
    if (j && typeof j.call === "string" && j.call.length > 0) {
      prose += response.slice(cursor, at);
      calls.push({ name: j.call, argumentsJson: JSON.stringify(j.args ?? {}) });
    } else {
      // Malformed or non-call object — keep the raw marker visible as prose.
      prose += response.slice(cursor, scanned.end);
    }
    cursor = scanned.end;
  }
  return { prose: prose.trim(), calls };
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
  const emptyRetries = opts.emptyRetries ?? DEFAULT_EMPTY_RETRIES;
  const messages: TextMessage[] = [
    { role: "system", content: `${opts.system}\n\n${textProtocolSpec(opts.tools)}` },
    { role: "user", content: opts.task },
  ];

  let steps = 0;
  while (steps < maxSteps) {
    if (aborted(opts.signal)) return { finalText: null, steps, stopReason: "aborted" };
    steps += 1;

    opts.hooks?.onUsage?.(estimateTokens(messages));
    // Re-ask an empty completion (no prose, no marker) a few times before
    // giving up — a local model can return a blank turn intermittently, and the
    // next attempt usually carries the real answer or tool call.
    let response = await opts.textTurn(messages);
    let parsed = parseTextToolCalls(response);
    for (
      let attempt = 1;
      attempt <= emptyRetries &&
      parsed.calls.length === 0 &&
      isBlank(parsed.prose) &&
      !aborted(opts.signal);
      attempt += 1
    ) {
      opts.hooks?.onEmptyRetry?.(attempt);
      response = await opts.textTurn(messages);
      parsed = parseTextToolCalls(response);
    }
    const { prose, calls } = parsed;
    if (prose && opts.hooks?.onReasoning && calls.length > 0) {
      // Mid-loop prose is working commentary, not the final answer.
      opts.hooks.onReasoning(prose);
    }

    if (calls.length === 0) {
      const finalText = prose.trim();
      opts.hooks?.onFinal?.(finalText);
      return {
        finalText: finalText.length > 0 ? finalText : null,
        steps,
        // Blank after retries is an `empty` stop (distinct, clearer message);
        // a non-blank answer with no marker is a clean finish.
        stopReason: finalText.length > 0 ? "final" : "empty",
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

// ---------- adaptive transport (agnostic tool routing) ----------

/** How the model was actually driven — decided by evidence, never by name. */
export type ToolTransport = "native" | "text";

export type AdaptiveLoopOptions = Omit<LoopOptions, "modelTurn"> & {
  modelTurn: ModelTurn;
  textTurn: TextTurn;
  /**
   * Start with native tool-calling? Comes from evidence the caller already has
   * (runtime-advertised capabilities, a previous observation this session) —
   * and defaults OPTIMISTIC: an unknown model gets offered the native API
   * first, because trying costs one cheap rejected request while assuming
   * costs the whole feature.
   */
  startNative: boolean;
  /**
   * Classify an error thrown by `modelTurn` as "this endpoint/model rejected
   * the tools parameter" (e.g. an HTTP 4xx provider rejection). Only such
   * errors trigger the text fallback; everything else propagates.
   */
  isToolsUnsupported?: (err: unknown) => boolean;
  /** Fired once if the run falls back native → text, so the caller can record the observation and tell the user. */
  onTransportFallback?: () => void;
};

export type AdaptiveLoopResult = LoopResult & { transport: ToolTransport };

/** Sentinel: the first native turn was rejected for using `tools`. */
class ToolsUnsupportedSentinel extends Error {
  constructor(public readonly cause: unknown) {
    super("native tool-calling rejected by the endpoint");
  }
}

/**
 * Drive the tool loop with the transport chosen by EVIDENCE, not model name:
 * start native (unless the caller already knows better), and if the endpoint
 * rejects the very first tools request, fall back to the text protocol and
 * finish the same task there. Once a native turn has succeeded, later errors
 * are real failures and propagate — no silent mid-run downgrades.
 */
export async function runAdaptiveToolLoop(
  opts: AdaptiveLoopOptions,
): Promise<AdaptiveLoopResult> {
  if (!opts.startNative) {
    const r = await runTextToolLoop(opts);
    return { ...r, transport: "text" };
  }

  // Guard the native turn: until one succeeds, a tools-shaped rejection means
  // "this endpoint can't do native tool-calling" rather than a hard error.
  let nativeSucceeded = false;
  const guardedTurn: ModelTurn = async (messages) => {
    try {
      const turn = await opts.modelTurn(messages);
      nativeSucceeded = true;
      return turn;
    } catch (err) {
      if (!nativeSucceeded && opts.isToolsUnsupported?.(err)) {
        throw new ToolsUnsupportedSentinel(err);
      }
      throw err;
    }
  };

  try {
    const r = await runNativeToolLoop({ ...opts, modelTurn: guardedTurn });
    return { ...r, transport: "native" };
  } catch (err) {
    if (!(err instanceof ToolsUnsupportedSentinel)) throw err;
    opts.onTransportFallback?.();
    const r = await runTextToolLoop(opts);
    return { ...r, transport: "text" };
  }
}
