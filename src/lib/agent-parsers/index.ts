import type { AgentEvent, AgentParser } from "./types";
import { createSmallCodeParser } from "./smallcode";
import { createProtocolParser, isAkaMarker } from "./protocol";
import { isNoise, stripAnsi } from "./noise";

/**
 * Default parser for agents we don't yet have a specialised
 * implementation for (Aider, OpenCode, custom shell wrappers, …).
 *
 * It still passes through model prose unchanged, but drops the
 * structured-logger noise that some agents print to stdout/stderr —
 * `INFO <timestamp> service=…` lines, stack-trace frames, JSON error
 * envelopes, ANSI colour codes. Those are diagnostic artifacts; the
 * ErrorBanner surfaces the meaningful crash reason separately, so
 * leaving them in the message body just buries the user's actual
 * reply (or, on a crash, buries the ErrorBanner itself under a wall
 * of timestamps).
 */
function createPassthroughParser(): AgentParser {
  return {
    feed: (line: string): AgentEvent[] => {
      const stripped = stripAnsi(line);
      if (isNoise(stripped)) return [];
      // Drop pure-whitespace lines that result from stripping ANSI
      // off a colour-reset-only fragment — they add empty padding to
      // the message body for no reason.
      if (stripped.trim().length === 0 && line.trim().length > 0) return [];
      return [{ type: "text", text: stripped }];
    },
    flush: () => [],
  };
}

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
    feed: (line) =>
      routeToPrimary(line) ? primary.feed(line) : fallback.feed(line),
    flush: () => [...primary.flush(), ...fallback.flush()],
  };
}

/**
 * The agent's own ("base") parser, chosen by binary basename. SmallCode has a
 * specialised glyph parser; everything else uses passthrough. The binary path
 * can be a bare name (`smallcode`) or an absolute path — we match the basename.
 */
function baseParserForAgent(bin: string | null | undefined): AgentParser {
  if (!bin) return createPassthroughParser();
  const base = bin.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base === "smallcode") return createSmallCodeParser();
  return createPassthroughParser();
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
