import type { AgentEvent, AgentParser } from "./types";
import { stripAnsi } from "./noise";
import { kindForToolName, pathFromInput } from "./react";

/**
 * Robustness parser for two common patterns some agents print to stdout that
 * neither the ReAct scaffolding nor the `@@aka` protocol covers — so they'd
 * otherwise leak into the timeline as raw text:
 *
 *   1. **XML-style tool calls** — `<tool_call>read_file path="src/x.ts" />`
 *      (also `<tool_call>{"name":"read_file","arguments":{…}}</tool_call>`).
 *      Turned into the same `tool_start`/`tool_end` chip events every other
 *      parser emits.
 *   2. **Provider error dumps** — `RateLimitError: Error code: 429 - {…}`,
 *      `[sub-agent error: …]`, `orch] ERROR during step 1: …`. The raw
 *      Python-repr exception (headers, `user_id`, metadata) is replaced with a
 *      single clean line carrying just the class, status, human message, and
 *      any link.
 *
 * Agent-agnostic and additive: this recognizes what an agent *already* prints;
 * it never asks an agent to change. Composed IN FRONT of the base parser (see
 * `parserForAgent`), routed by [`isReActExtra`] so only matching lines reach
 * it — everything else flows through the agent's own parser untouched.
 *
 * The provider-error output is a plain `text` event (a cleaned-up line), so
 * this needs no chat-store or renderer changes. A distinct error card can be
 * layered on later without touching this recognizer.
 */

// --- XML-style tool calls --------------------------------------------------

/** Line opens an XML-style `<tool_call …>` (self-closing or paired). */
const TOOL_CALL_RE = /^\s*<tool_call\b/i;

// --- Provider error dumps --------------------------------------------------

/** SDK/agent exception class names that signal a provider-side failure. */
const ERROR_CLASS_RE =
  /\b([A-Z][A-Za-z]*(?:Error|Exception))\b/;
/** `Error code: 429` / `'code': 429` — an HTTP status embedded in the dump. */
const STATUS_RE = /(?:Error code:|['"]code['"]\s*:)\s*(\d{3})\b/;
/** First URL in the dump (usually the provider's "add your own key" link). */
const URL_RE = /(https?:\/\/[^\s'"}\])]+)/;
/** Python-repr or JSON `message`/`raw` string values inside the dump. */
const MESSAGE_RE = /['"]message['"]\s*:\s*['"]([^'"]*)['"]/;
const RAW_MSG_RE = /['"]raw['"]\s*:\s*['"]([^'"]*)['"]/;

/**
 * A line looks like a provider error the agent surfaced. Conservative on
 * purpose — a false negative just falls back to today's raw passthrough, while
 * a false positive would hide real content. Requires an explicit signal, not
 * merely the word "error".
 */
function isProviderErrorLine(line: string): boolean {
  const s = stripAnsi(line);
  return (
    /\b\w*(?:Error|Exception)\s*:/.test(s) && /(?:Error code:|['"]code['"]\s*:)\s*\d{3}/.test(s)
      ? true
      : /^\s*\[sub-agent error:/i.test(s) || /^\s*orch\]\s*ERROR\b/i.test(s)
  );
}

/** True when a line should be handled here instead of the base parser. */
export function isReActExtra(line: string): boolean {
  const s = stripAnsi(line);
  return TOOL_CALL_RE.test(s) || isProviderErrorLine(s);
}

/** Split `<tool_call>…</tool_call>` / `<tool_call … />` down to its inner body. */
function toolCallBody(line: string): string {
  return stripAnsi(line)
    .trim()
    .replace(/^<tool_call>\s*/i, "")
    .replace(/\s*<\/tool_call>\s*$/i, "")
    .replace(/\s*\/?>\s*$/i, "")
    .trim();
}

/** Parse an XML-style tool-call line into paired start/end chip events. */
function parseToolCall(line: string): AgentEvent[] {
  const body = toolCallBody(line);
  if (!body) return [];

  let name = "";
  let input: string | undefined;
  let path: string | undefined;

  if (body.startsWith("{")) {
    // `<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>`
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      name =
        (typeof obj.name === "string" && obj.name) ||
        (typeof obj.tool === "string" && obj.tool) ||
        "";
      const args = obj.arguments ?? obj.args ?? {};
      input = typeof args === "string" ? args : JSON.stringify(args);
      path = pathFromInput(input);
    } catch {
      return []; // malformed — never leak the raw brace soup as a chip
    }
  } else {
    // `read_file path="src/x.ts"` — first token is the name, rest are attrs.
    const sp = body.search(/\s/);
    name = (sp < 0 ? body : body.slice(0, sp)).trim();
    input = sp < 0 ? undefined : body.slice(sp + 1).trim();
    path = input ? pathFromInput(input) : undefined;
  }

  if (!name) return [];

  const start: AgentEvent = {
    type: "tool_start",
    name,
    kind: kindForToolName(name),
    ...(path ? { path } : {}),
    ...(input ? { input } : {}),
  };
  // Self-contained line: no separate observation follows, so settle it now.
  const end: AgentEvent = {
    type: "tool_end",
    ok: true,
    ...(path ? { path } : {}),
  };
  return [start, end];
}

/** Reduce a raw provider-error dump to one clean, human line. */
function cleanProviderError(line: string): string {
  const s = stripAnsi(line).trim();
  const cls = s.match(ERROR_CLASS_RE)?.[1];
  const status = s.match(STATUS_RE)?.[1];
  const msg = s.match(MESSAGE_RE)?.[1]?.trim();
  const raw = s.match(RAW_MSG_RE)?.[1]?.trim();
  const url = s.match(URL_RE)?.[1];

  // Prefer the `raw` upstream detail when it adds something over `message`.
  const detailParts: string[] = [];
  if (msg) detailParts.push(msg);
  if (raw && raw !== msg) detailParts.push(raw);
  let detail = detailParts.join(" — ");

  // Drop a trailing URL already present inside the detail; we append it once.
  if (url && detail.includes(url)) detail = detail.replace(url, "").trim();
  detail = detail.replace(/[\s:—-]+$/, "").trim();

  const label = [cls ?? "Provider error", status].filter(Boolean).join(" ");
  const head = `[${label}]`;
  const tail = [detail || "the provider rejected the request", url]
    .filter(Boolean)
    .join(" · ");
  return `${head} ${tail}`;
}

export function createReActExtrasParser(): AgentParser {
  return {
    feed(line: string): AgentEvent[] {
      const s = stripAnsi(line);
      if (TOOL_CALL_RE.test(s)) return parseToolCall(line);
      if (isProviderErrorLine(s)) {
        return [{ type: "text", text: cleanProviderError(line) }];
      }
      return []; // routing sent us a non-matching line — ignore
    },
    flush: () => [],
  };
}
