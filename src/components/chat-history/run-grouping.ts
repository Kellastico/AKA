import type { Message } from "../../stores/use-messages-store";

/**
 * A rendered group in the chat thread: either a single user/assistant message,
 * or an agent *run* — a maximal sequence of consecutive reasoning + tool
 * messages plus the trailing assistant answer — that the RunTimeline draws as
 * one ordered, interleaved timeline.
 */
export type RunGroup =
  | { kind: "single"; message: Message; key: string }
  | { kind: "run"; messages: Message[]; key: string };

/**
 * Fold a flat message list into render groups.
 *
 * Reasoning and tool messages are emitted by the agent stream in the exact
 * order they occurred, so a contiguous span of them *is* the run timeline —
 * we just gather the span (and the assistant answer that follows it) under one
 * group. Plain user messages, and standalone assistant replies with no
 * preceding activity (Ask/Edit mode), stay as individual entries.
 */
export function groupRunMessages(messages: Message[]): RunGroup[] {
  const result: RunGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "reasoning" || m.role === "tool") {
      const runMsgs: Message[] = [];
      while (
        i < messages.length &&
        (messages[i].role === "reasoning" || messages[i].role === "tool")
      ) {
        runMsgs.push(messages[i]);
        i++;
      }
      // Absorb the run's final answer (the next assistant message).
      if (i < messages.length && messages[i].role === "assistant") {
        runMsgs.push(messages[i]);
        i++;
      }
      result.push({ kind: "run", messages: runMsgs, key: `run-${runMsgs[0].id}` });
    } else {
      result.push({ kind: "single", message: m, key: m.id });
      i++;
    }
  }
  return result;
}
