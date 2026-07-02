import type { AgentEvent, AgentParser, ToolKind } from "./types";
import { stripAnsi } from "./noise";

/**
 * AKA-native, agent-agnostic tool-activity protocol.
 *
 * Any agent — LangChain, Aider, a custom script — can surface its tool calls
 * (reads, searches, shell commands, writes) in AKA's "Agent worked" accordion
 * by printing sentinel lines to stdout as it works:
 *
 *   @@aka {"tool":"read","path":"src/App.jsx"}
 *   @@aka {"tool":"search","name":"grep","preview":"useEffect"}
 *   @@aka {"tool":"run","name":"bash","preview":"npm test","ok":true,"ms":840}
 *   @@aka {"tool":"write","path":"src/x.ts","linesAdded":12,"linesRemoved":3}
 *
 * One marker = one complete tool call (emits a paired tool_start + tool_end).
 * For long-running tools an agent may split it with `"phase":"start"` then a
 * later `"phase":"end"` carrying the same shape.
 *
 * This parser is composed IN FRONT OF every agent's base parser (see
 * `parserForAgent`), so the protocol works for ALL agents while their natural
 * prose / native formats still flow through untouched. It emits the SAME
 * `AgentEvent` shapes the chat store already consumes — no downstream changes.
 */

/** A marker line: `@@aka <json>` (json captured in group 1). */
const MARKER_RE = /^\s*@@aka\s+(\{.*\})\s*$/;

/** True when a raw output line is an `@@aka` tool-event marker. */
export function isAkaMarker(line: string): boolean {
  return MARKER_RE.test(stripAnsi(line));
}

const KIND_MAP: Record<string, ToolKind> = {
  read: "read",
  write: "write",
  run: "run",
  search: "search",
};

/** Map the marker's `tool` field to AKA's ToolKind; unknown → "run". */
function toKind(t: unknown): ToolKind {
  return (typeof t === "string" && KIND_MAP[t.toLowerCase()]) || "run";
}

type Marker = {
  /** Handshake markers (`{"announce":"capability-contract",…}`) — not a tool
   *  call. Carry the same capability fields a `--äkä-probe` answer does; surfaced
   *  as a `capabilities` event (the in-band fallback), never as chat or a row. */
  announce?: string;
  manages_llm?: boolean;
  supports_streaming?: boolean;
  supports_dry_run?: boolean;
  required_args?: string[];
  "capability-contract"?: string | null;
  capability_folders?: string[];
  /** Host-action control marker, e.g. `{"control":"dev_server","action":"restart"}`
   *  — lets the agent drive a host capability (currently the dev server) instead
   *  of the user clicking the button. Not a tool call. */
  control?: string;
  action?: string;
  /** Control-plane events, e.g. `{"event":"context",…}` — not a tool call. */
  event?: string;
  used_tokens?: number;
  context_window?: number;
  tool?: string;
  name?: string;
  path?: string;
  preview?: string;
  ok?: boolean;
  ms?: number;
  phase?: "start" | "end";
  linesAdded?: number;
  linesRemoved?: number;
  /** Host witness: SHA-256 of the real post-edit content (recorded change). */
  hash?: string;
};

export function createProtocolParser(): AgentParser {
  return {
    feed(line: string): AgentEvent[] {
      const m = stripAnsi(line).match(MARKER_RE);
      if (!m) return []; // not a marker — routing should have sent this elsewhere
      let j: Marker;
      try {
        j = JSON.parse(m[1]) as Marker;
      } catch {
        return []; // malformed marker — drop it, never throw or leak as prose
      }

      // Host-action control marker — the agent asks the host to drive a
      // capability (open/kill/restart the dev server) instead of the user
      // clicking the button. Surfaced as a `control` event the chat store acts
      // on; never a tool row or chat prose.
      if (typeof j.control === "string" && j.control.length > 0) {
        return [
          {
            type: "control",
            target: j.control,
            action: typeof j.action === "string" ? j.action : "",
          },
        ];
      }

      // Capability-contract / handshake markers are control plane, not a tool
      // call. Surface the advertised capabilities as a `capabilities` event (the
      // in-band fallback for `--äkä-probe`) so the host can cache them for the
      // session; the raw JSON itself never lands in the chat or as a tool row.
      if (j.announce !== undefined) {
        return [
          {
            type: "capabilities",
            probe: {
              type: "agent",
              name: typeof j.name === "string" ? j.name : "",
              manages_llm: j.manages_llm === true,
              supports_streaming: j.supports_streaming === true,
              supports_dry_run: j.supports_dry_run === true,
              required_args: Array.isArray(j.required_args) ? j.required_args : [],
              "capability-contract":
                typeof j["capability-contract"] === "string"
                  ? j["capability-contract"]
                  : null,
              capability_folders: Array.isArray(j.capability_folders)
                ? j.capability_folders
                : [],
            },
          },
        ];
      }

      // Live context-usage report: the agent tells the host its REAL prompt size
      // (which the host can't see inside the subprocess) so the context meter is
      // accurate during a run. Control plane — never a tool card.
      if (j.event === "context") {
        const usedTokens = j.used_tokens;
        if (typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0) {
          const cw = j.context_window;
          const contextWindow =
            typeof cw === "number" && Number.isFinite(cw) && cw > 0 ? cw : 0;
          return [{ type: "context", usedTokens, contextWindow }];
        }
        return [];
      }

      const kind = toKind(j.tool);
      const name =
        (typeof j.name === "string" && j.name) ||
        (typeof j.tool === "string" ? j.tool : "tool");
      const path = typeof j.path === "string" ? j.path : undefined;

      const start: AgentEvent = {
        type: "tool_start",
        name,
        kind,
        ...(path ? { path } : {}),
      };
      const end: AgentEvent = {
        type: "tool_end",
        ok: j.ok !== false, // default to success unless explicitly false
        ...(typeof j.ms === "number" ? { elapsedMs: j.ms } : {}),
        ...(typeof j.preview === "string" ? { preview: j.preview } : {}),
        ...(path ? { path } : {}),
        ...(typeof j.linesAdded === "number" ? { linesAdded: j.linesAdded } : {}),
        ...(typeof j.linesRemoved === "number"
          ? { linesRemoved: j.linesRemoved }
          : {}),
        ...(typeof j.hash === "string" ? { hash: j.hash } : {}),
      };

      if (j.phase === "start") return [start];
      if (j.phase === "end") return [end];
      return [start, end];
    },
    flush: () => [],
  };
}
