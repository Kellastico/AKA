import type { AgentParser } from "./types";
import { normalizeControl } from "./noise";
import { createSmallCodeParser } from "./smallcode";
import { createReActParser } from "./react";
import { createProtocolParser, isAkaMarker } from "./protocol";

/**
 * Route each line to `primary` when `routeToPrimary(line)` is true, else to
 * `fallback`. Lets the AKA-native `@@aka` protocol parser sit in FRONT of any
 * agent's base parser: marker lines become structured tool events; everything
 * else flows through the agent's own parser (SmallCode glyphs, plain prose, …).
 * `flush` drains both so no buffered state is lost.
 */
export function composeParsers(
  primary: AgentParser,
  fallback: AgentParser,
  routeToPrimary: (line: string) => boolean,
): AgentParser {
  return {
    feed: (line) => {
      // Normalize terminal control bytes (backspace spinners, etc.) ONCE here so
      // both the routing decision and the chosen parser see a clean line — raw
      // `\b` artifacts otherwise render as ▯ boxes and break line-anchored
      // matches (`@@aka`, `Thought:`, `<think>`).
      const clean = normalizeControl(line);
      return routeToPrimary(clean) ? primary.feed(clean) : fallback.feed(clean);
    },
    flush: () => [...primary.flush(), ...fallback.flush()],
  };
}

/**
 * The agent's own ("base") parser, chosen by binary basename. SmallCode has a
 * specialised glyph parser; every other agent gets the ReAct parser, which
 * stays dormant (pure passthrough) until it sees `Thought:` / `Action:` /
 * `Observation:` scaffolding — so plain-prose agents are unaffected while
 * ReAct agents (Änyä, Enyö-Änyä, any LlamaIndex `ReActAgent`) get structured
 * reasoning + tool events. The binary path can be a bare name (`smallcode`)
 * or an absolute path — we match the basename.
 */
function baseParserForAgent(bin: string | null | undefined): AgentParser {
  if (!bin) return createReActParser();
  const base = bin.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base === "smallcode") return createSmallCodeParser();
  return createReActParser();
}

/**
 * Parser for a spawned agent. The AKA-native `@@aka` tool-event protocol is
 * composed in front of the agent's base parser, so *any* agent that emits the
 * markers gets the "Agent worked" activity — not just SmallCode — while its
 * native output is still parsed as before.
 */
export function parserForAgent(bin: string | null | undefined): AgentParser {
  return composeParsers(
    createProtocolParser(),
    baseParserForAgent(bin),
    isAkaMarker,
  );
}

export type { AgentEvent, AgentParser } from "./types";
