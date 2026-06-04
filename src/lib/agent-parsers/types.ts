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
 * Text events are residue: everything the parser didn't recognise as
 * structured tool activity. That's where the agent's natural-language
 * reply ends up.
 */
export type ToolKind = "read" | "write" | "run" | "search";

export type AgentEvent =
  | { type: "tool_start"; name: string; kind: ToolKind; path?: string }
  | {
      type: "tool_end";
      ok: boolean;
      elapsedMs?: number;
      preview?: string;
      path?: string;
      linesAdded?: number;
      linesRemoved?: number;
    }
  | { type: "text"; text: string };

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
