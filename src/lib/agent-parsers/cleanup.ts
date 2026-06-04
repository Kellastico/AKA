import { createSmallCodeParser } from "./smallcode";
import { isNoise, stripAnsi } from "./noise";
import type { Message } from "../../stores/use-messages-store";
import type { AgentEvent, ToolKind } from "./types";

/**
 * One-time retroactive cleanup for messages that were stored BEFORE the
 * agent-parser pipeline existed. Old SmallCode runs dumped their entire
 * tool trace (⚙ / ✓ / ┌─ / └─ glyphs, hunk lines, "─── N tool calls ───")
 * straight into the assistant message body. This pass walks every
 * archived message, re-parses that text through the SmallCode parser,
 * and produces:
 *
 *   1. A cleaned assistant message whose `content` is just the prose.
 *   2. Zero or more `role: "tool"` messages spliced in BEFORE the
 *      assistant message, in the order the tools fired.
 *
 * Messages that don't look like SmallCode output are returned unchanged.
 * We detect "SmallCode-shaped" content by sniffing for the ⚙ gear OR the
 * "─── N tool calls this turn ───" footer in the body — both are unique
 * to SmallCode and very unlikely to appear in genuine prose.
 */

const SMALLCODE_SIGNATURE = /(⚙|─── \d+ tool calls? this turn ───)/;

/**
 * Cheap pass that ONLY strips noise from a message's body — used when
 * the message isn't SmallCode-shaped but still carries log/stack-trace
 * garbage from a different agent (OpenCode crash dumps, etc.).
 */
function scrubNoise(message: Message): Message {
  if (message.role !== "assistant") return message;
  if (!message.content) return message;
  const lines = message.content.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const stripped = stripAnsi(line);
    if (isNoise(stripped)) continue;
    kept.push(stripped);
  }
  const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (next === message.content) return message; // unchanged → keep reference
  return { ...message, content: next };
}

function eventToToolMessage(
  start: Extract<AgentEvent, { type: "tool_start" }>,
  end: Extract<AgentEvent, { type: "tool_end" }> | null,
  parentAgentId: string | undefined,
  parentModelId: string | undefined,
  baseId: string,
  index: number,
  timestamp: string,
): Message {
  return {
    id: `${baseId}-tool-${index}`,
    role: "tool",
    content: "",
    timestamp,
    agentId: parentAgentId,
    modelId: parentModelId,
    toolKind: start.kind as ToolKind,
    toolName: start.name,
    toolPath: end?.path ?? start.path,
    toolStatus: end ? (end.ok ? "done" : "failed") : "failed",
    toolElapsedMs: end?.elapsedMs,
    toolPreview: end?.preview,
    linesAdded: end?.linesAdded,
    linesRemoved: end?.linesRemoved,
  };
}

/**
 * Re-parse a single assistant message whose body contains a SmallCode
 * trace. Returns an ordered list of messages to replace it with — tool
 * rows followed by the cleaned assistant row.
 */
export function backfillSmallCodeTrace(message: Message): Message[] {
  if (message.role !== "assistant") return [message];
  if (!message.content) return [message];
  // No SmallCode trace? Still strip log noise so OpenCode/Aider crashes
  // don't read like a 200-line wall of timestamps.
  if (!SMALLCODE_SIGNATURE.test(message.content)) {
    return [scrubNoise(message)];
  }

  const parser = createSmallCodeParser();
  const lines = message.content.split("\n");
  const events: AgentEvent[] = [];
  for (const line of lines) {
    events.push(...parser.feed(line));
  }
  events.push(...parser.flush());

  // Walk events: collect tool messages, accumulate residual text.
  const toolMessages: Message[] = [];
  let pendingStart: Extract<AgentEvent, { type: "tool_start" }> | null = null;
  let textParts: string[] = [];

  for (const event of events) {
    if (event.type === "tool_start") {
      if (pendingStart) {
        // No matching end — surface as a failed row.
        toolMessages.push(
          eventToToolMessage(
            pendingStart,
            null,
            message.agentId,
            message.modelId,
            message.id,
            toolMessages.length,
            message.timestamp,
          ),
        );
      }
      pendingStart = event;
    } else if (event.type === "tool_end") {
      if (pendingStart) {
        toolMessages.push(
          eventToToolMessage(
            pendingStart,
            event,
            message.agentId,
            message.modelId,
            message.id,
            toolMessages.length,
            message.timestamp,
          ),
        );
        pendingStart = null;
      }
      // tool_end with no pending start is dropped — happens when an
      // "✓ Edited <path>" line slipped past without a preceding ⚙.
    } else {
      textParts.push(event.text);
    }
  }
  if (pendingStart) {
    toolMessages.push(
      eventToToolMessage(
        pendingStart,
        null,
        message.agentId,
        message.modelId,
        message.id,
        toolMessages.length,
        message.timestamp,
      ),
    );
  }

  // Rebuild the cleaned content: trim trailing/leading whitespace and
  // collapse runs of blank lines.
  const cleaned = textParts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // If the assistant message is now empty AND we recovered tools, drop
  // it entirely — the tool rows tell the story.
  if (cleaned.length === 0 && toolMessages.length > 0) {
    return toolMessages;
  }

  return [...toolMessages, { ...message, content: cleaned }];
}

/** Run the backfill across an entire session's message archive. */
export function backfillSession(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    out.push(...backfillSmallCodeTrace(m));
  }
  return out;
}
