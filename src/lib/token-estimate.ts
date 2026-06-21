import type { ChatMessage } from "./tauri/commands";
import type { Message } from "../stores/use-messages-store";

/**
 * Single source of truth for turning session messages into the `{role, content}`
 * shape the token counters reason about — so every token figure in the app
 * (the context-window meter AND each run's footer) counts the *same content the
 * same way* and the numbers never contradict each other.
 *
 * Only content that actually persists in the model's context window is counted:
 *
 *   • user / assistant → their text (this is what the history builder replays).
 *   • tool             → a compact `[kind] path` stub (the call is summarised in
 *                        context, never the full I/O).
 *   • reasoning        → nothing. A model's thinking is generated, shown once,
 *                        and dropped — it is never replayed on later turns, so
 *                        it must not inflate the context estimate.
 *
 * Empty results are filtered so an abandoned/empty turn contributes zero.
 */
export function toChatMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "reasoning") continue;
    if (m.role === "user") {
      if (m.content.trim()) out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      if (m.content.trim()) out.push({ role: "assistant", content: m.content });
      continue;
    }
    // tool — summarise as the context sees it: kind + path, never raw I/O.
    const stub = `[${m.toolKind ?? "tool"}] ${m.toolPath ?? ""}`.trim();
    out.push({ role: "assistant", content: stub });
  }
  return out;
}

/**
 * Local mirror of the Rust `count_tokens` heuristic (serialise to JSON, divide
 * the character count by 4). Used wherever a synchronous, render-time estimate
 * is needed (run footers) so it agrees with the backend-counted context meter
 * to within rounding — both are approximations and must carry a "~" in the UI.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  return Math.round(JSON.stringify(messages).length / 4);
}
