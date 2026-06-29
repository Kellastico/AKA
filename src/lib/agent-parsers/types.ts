/**
 * Agent-output parser events.
 *
 * Each parser turns a stream of raw stdout lines from a particular agent
 * (SmallCode, Aider, OpenCode, our LangChain wrapper, …) into a uniform
 * sequence of these events. The chat store consumes the events without
 * caring which agent emitted them, so the UI can stay agent-agnostic.
 *
 * Tools follow a start/end pairing — a tool_start spawns a "running"
 * ToolMessage, the matching tool_end flips it to done/failed.
 *
 * Reasoning follows the same start/delta/end shape: a reasoning_start opens
 * a "streaming" reasoning segment, reasoning_delta appends thinking text to
 * it, and reasoning_end settles it. Each segment is its own node in the run
 * timeline, so a ReAct agent's interleaved Thoughts read as discrete steps
 * between tool calls instead of one undifferentiated blob.
 *
 * Text events are residue: everything the parser didn't recognise as
 * structured tool/reasoning activity. That's where the agent's final
 * user-facing reply ends up.
 */
export type ToolKind = "read" | "write" | "run" | "search";

export type AgentEvent =
  | {
      type: "tool_start";
      name: string;
      kind: ToolKind;
      path?: string;
      /** Readable tool input (e.g. a ReAct `Action Input` JSON line). */
      input?: string;
    }
  | {
      type: "tool_end";
      ok: boolean;
      elapsedMs?: number;
      preview?: string;
      path?: string;
      linesAdded?: number;
      linesRemoved?: number;
    }
  | { type: "reasoning_start" }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_end" }
  | { type: "text"; text: string }
  /**
   * Live context-usage report from the agent. AKA can't see the agent
   * subprocess's real prompt (system prompt + scratchpad + tool observations),
   * so the agent self-reports its actual token usage to drive the host's
   * context meter accurately. Control-plane only — never rendered as content.
   */
  | { type: "context"; usedTokens: number; contextWindow: number };

/**
 * Stateful line-by-line parser. Implementations buffer partial state
 * across calls (e.g. waiting for the next line after a tool_start to
 * decide whether it's tool_end or a diff block).
 *
 * `feed` is called once per stdout line as it arrives. `flush` is called
 * once at the end of the stream so any pending state can be drained into
 * final events.
 */
export interface AgentParser {
  feed(line: string): AgentEvent[];
  flush(): AgentEvent[];
}
