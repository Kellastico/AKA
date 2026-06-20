import type { AgentEvent, AgentParser, ToolKind } from "./types";
import { isNoise, stripAnsi } from "./noise";

/**
 * Parser for ReAct-style agents (LlamaIndex `ReActAgent`, and any agent that
 * prints the canonical `Thought / Action / Action Input / Observation / Answer`
 * scaffolding to stdout).
 *
 * The format leaks badly when treated as prose — the raw `Action:` /
 * `Action Input:` / `Observation:` lines pile up in the reasoning/body. This
 * parser turns each piece into a typed event so the run timeline can render
 * structure instead of scaffolding:
 *
 *   Thought:        → reasoning_start … reasoning_delta* … reasoning_end
 *   Action:         → (remembers the tool name)
 *   Action Input:   → tool_start  (clean header + readable input)
 *   Observation:    → tool_end    (observation text becomes the tool output)
 *   Answer:         → text         (the final user-facing reply)
 *
 * It is *dormant* until it sees its first ReAct keyword: before activation
 * every line passes straight through as `text` (with the same noise filtering
 * the passthrough parser applies). So a non-ReAct agent that never prints
 * `Thought:` is unaffected — this parser can safely sit as the base parser for
 * any agent that isn't SmallCode.
 *
 * Ordering is preserved exactly: events come out in the order the agent
 * printed them, which is what lets reasoning and tools interleave downstream.
 */

/** Line-leading ReAct section keywords (case-insensitive, colon-terminated). */
const THOUGHT_RE = /^\s*Thought\s*:\s?(.*)$/i;
const ACTION_RE = /^\s*Action\s*:\s?(.*)$/i;
const ACTION_INPUT_RE = /^\s*Action\s*Input\s*:\s?(.*)$/i;
const OBSERVATION_RE = /^\s*Observation\s*:\s?(.*)$/i;
const ANSWER_RE = /^\s*(?:Final\s+)?Answer\s*:\s?(.*)$/i;

/**
 * Splits a line *before* each capitalised ReAct keyword so a model that writes
 * the next step on the same line as its prose — e.g. "…list the files.Action:
 * list_directory" — still parses cleanly instead of leaking the scaffolding
 * into the reasoning. Capitalised + colon-terminated to avoid splitting
 * ordinary prose; `Action Input` is listed before `Action` so the longer
 * keyword wins. Applied only outside observations/answers (see `feed`), where
 * keyword-like text is data, not structure.
 */
const SPLIT_RE = /(?=(?:Thought|Action\s*Input|Action|Observation|Final\s*Answer|Answer)\s*:)/;

/** True when a (stripped) line opens any ReAct section. */
export function isReActLine(line: string): boolean {
  const s = stripAnsi(line);
  return (
    THOUGHT_RE.test(s) ||
    ACTION_INPUT_RE.test(s) || // before ACTION_RE — "Action Input" also matches Action
    ACTION_RE.test(s) ||
    OBSERVATION_RE.test(s) ||
    ANSWER_RE.test(s)
  );
}

/** Map a tool name to AKA's broad ToolKind for colour-coding. */
function kindForToolName(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/(search|find|grep|list|glob|ls|locate)/.test(n)) return "search";
  if (/(write|edit|patch|create|append|insert|replace|modify|save)/.test(n))
    return "write";
  if (/(read|open|cat|view|load|get|fetch|show)/.test(n)) return "read";
  return "run";
}

/** Common keys an Action Input JSON uses to name the file it touches. */
const PATH_KEYS = ["path", "file", "file_path", "filename", "filepath", "dir"];

/** Best-effort path extraction from an Action Input string (usually JSON). */
function pathFromInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of PATH_KEYS) {
        const v = obj[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    } catch {
      // not valid JSON — fall through to the regex probe
    }
  }
  // `path=src/App.tsx` / `"file": "x.ts"` style without full JSON.
  const m = trimmed.match(
    /(?:path|file|file_path|filename)["']?\s*[:=]\s*["']?([^"',}\s]+)/i,
  );
  return m ? m[1] : undefined;
}

/** Collapse an observation to a compact one-line preview. */
function previewFromObservation(obs: string): string | undefined {
  const clean = obs.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > 160 ? clean.slice(0, 160) + "…" : clean;
}

type Section = "none" | "thought" | "action" | "action_input" | "observation" | "answer";

export function createReActParser(): AgentParser {
  let section: Section = "none";
  // Reasoning segment currently open (between reasoning_start and _end).
  let reasoningOpen = false;
  // Tool in-flight: `toolName` is set from `Action:`; `toolEmitted` flips true
  // once tool_start has been sent (at `Action Input:` or `Observation:`).
  let toolName: string | null = null;
  let toolEmitted = false;
  let obsBuf = "";

  /** Settle the open reasoning segment, if any. */
  const endReasoning = (): AgentEvent[] => {
    if (!reasoningOpen) return [];
    reasoningOpen = false;
    return [{ type: "reasoning_end" }];
  };

  /**
   * Settle the in-flight tool, if any — emitting a deferred tool_start first
   * (action with no Action Input) and folding a buffered observation into the
   * tool's output preview. A no-op when no tool is pending.
   */
  const endTool = (ok = true): AgentEvent[] => {
    if (!toolName && !toolEmitted) return [];
    const out: AgentEvent[] = [];
    if (toolName && !toolEmitted) {
      out.push({ type: "tool_start", name: toolName, kind: kindForToolName(toolName) });
    }
    const preview = section === "observation" ? previewFromObservation(obsBuf) : undefined;
    out.push({ type: "tool_end", ok, ...(preview ? { preview } : {}) });
    toolName = null;
    toolEmitted = false;
    obsBuf = "";
    return out;
  };

  const handle = (raw: string): AgentEvent[] => {
    const line = stripAnsi(raw);

    const thoughtM = line.match(THOUGHT_RE);
    if (thoughtM) {
      const out = [...endTool(), ...endReasoning()];
      section = "thought";
      reasoningOpen = true;
      out.push({ type: "reasoning_start" });
      if (thoughtM[1].trim()) out.push({ type: "reasoning_delta", text: thoughtM[1] });
      return out;
    }

    // "Action Input:" must be tested before "Action:" (prefix overlap). It
    // continues the current action — never closes it.
    const inputM = line.match(ACTION_INPUT_RE);
    if (inputM) {
      const out = endReasoning();
      section = "action_input";
      const input = inputM[1].trim();
      const name = toolName ?? "tool";
      const path = pathFromInput(input);
      out.push({
        type: "tool_start",
        name,
        kind: kindForToolName(name),
        ...(path ? { path } : {}),
        ...(input ? { input } : {}),
      });
      toolEmitted = true;
      return out;
    }

    const actionM = line.match(ACTION_RE);
    if (actionM) {
      const out = [...endTool(), ...endReasoning()];
      section = "action";
      toolName = actionM[1].trim() || "tool";
      toolEmitted = false;
      return out;
    }

    const obsM = line.match(OBSERVATION_RE);
    if (obsM) {
      const out = endReasoning();
      section = "observation";
      // An action with no Action Input still needs its tool_start before the
      // observation can close it.
      if (toolName && !toolEmitted) {
        out.push({ type: "tool_start", name: toolName, kind: kindForToolName(toolName) });
        toolEmitted = true;
      }
      obsBuf = obsM[1];
      return out;
    }

    const answerM = line.match(ANSWER_RE);
    if (answerM) {
      const out = [...endTool(), ...endReasoning()];
      section = "answer";
      if (answerM[1].length > 0) out.push({ type: "text", text: answerM[1] });
      return out;
    }

    // Continuation lines — belong to whatever section is open.
    if (section === "thought") {
      return line.trim() ? [{ type: "reasoning_delta", text: line }] : [];
    }
    if (section === "observation") {
      obsBuf += "\n" + line;
      return [];
    }
    if (section === "answer") {
      if (isNoise(line)) return [];
      return [{ type: "text", text: line }];
    }
    if (section === "action" || section === "action_input") {
      // Stray lines mid-tool (rare multi-line input) — swallow so raw
      // scaffolding never leaks; they aren't user-facing prose.
      return [];
    }

    // Between sections / never activated — behave like the passthrough parser.
    if (isNoise(line)) return [];
    if (line.trim().length === 0 && raw.trim().length > 0) return [];
    return [{ type: "text", text: line }];
  };

  return {
    feed: (raw: string): AgentEvent[] => {
      // Don't split inside an observation (tool output) or the final answer —
      // there, "Action:"/"Thought:" are data, not new ReAct steps.
      if (section === "observation" || section === "answer") return handle(raw);
      const out: AgentEvent[] = [];
      const segs = raw.split(SPLIT_RE).filter((s) => s.length > 0);
      for (let i = 0; i < segs.length; i++) {
        out.push(...handle(segs[i]));
        // The moment a segment drops us into a data section, the rest of the
        // line is that section's content — append it verbatim instead of
        // re-parsing keyword-like text out of it. (Split is zero-width, so
        // joining the tail reconstructs the original substring exactly.)
        // `handle` mutates `section`, which TS can't see through the early
        // guard above — cast back to the full union to re-check it.
        const now = section as Section;
        const rest = segs.slice(i + 1).join("");
        if (now === "observation") {
          obsBuf += rest;
          break;
        }
        if (now === "answer") {
          if (rest && !isNoise(rest)) out.push({ type: "text", text: rest });
          break;
        }
      }
      return out;
    },
    flush: () => [...endTool(), ...endReasoning()],
  };
}
