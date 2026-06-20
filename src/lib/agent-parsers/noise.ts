/**
 * Patterns for "log noise" — output that comes from an agent's internal
 * service plumbing (structured loggers, stack traces, JSON-serialised
 * error causes, ANSI colour codes) rather than the model's actual reply.
 *
 * AKA's chat is meant to show the assistant's prose; the ErrorBanner
 * already surfaces the diagnostic stderr tail for crashes. So we drop
 * these patterns from the message body before they ever reach the
 * renderer.
 *
 * Each pattern is intentionally narrow — we'd rather let one borderline
 * line through than swallow a legitimate model reply that happens to
 * start with the word "INFO" or contain a path.
 */

/** `INFO 2026-05-25T04:42:51 +1ms service=…` and friends. */
const STRUCTURED_LOG_RE =
  /^\s*(INFO|WARN|DEBUG|ERROR|TRACE|FATAL)\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Node/Bun stack-trace frames: `at Foo.bar (/path/file.js:123:45)`. */
const STACK_TRACE_RE = /^\s*at\s+\S+\s*\([^)]+:\d+:\d+\)\s*$/;

/** Bun-internal frames without a function name: `at /$bunfs/…:N:N`. */
const BUN_INTERNAL_FRAME_RE = /^\s*at\s+\/\$bunfs\//;

/** OpenCode / Effect-style JSON error envelopes dumped on one line. */
const JSON_CAUSE_RE = /^\s*\{["'](_id|_tag)["']:\s*["']?Cause/;

/**
 * Lines that ONLY contain "service=foo type=bar status=…" key/value
 * fragments — these are the continuation of a wrapped structured log
 * line that didn't start with INFO/ERROR. Drop them too.
 */
const KV_FRAGMENT_RE =
  /^\s*(?:service|type|cause|status|directory|path|id|ref)=\S+(?:\s+(?:service|type|cause|status|directory|path|id|ref)=\S+)+\s*$/;

/** ANSI SGR escape sequences — proper form AND the malformed form that
 * leaks through when the ESC byte gets remapped to a replacement char.
 *
 * The prefix is REQUIRED: an ESC byte (`\x1b`) or one of the replacement
 * chars it can decay into (`�◇□`) must precede the `[…m` for it to count
 * as an SGR sequence. Making it optional would also strip bare `[<digits>m`
 * out of legitimate prose (`arr[0m]` → `arr]`, `[3m` → ``), silently
 * corrupting the model's reply. */
export const ANSI_RE = /(?:\x1b|[�◇□])\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Normalize terminal control bytes that agents leak into stdout (spinners,
 * progress indicators, readline echo). Backspace (`\b`, 0x08) is *applied* —
 * it deletes the preceding char the way a terminal would — so an artifact like
 * `"D\b\b "` collapses to a space instead of rendering as ▯ boxes AND shoving
 * real content (an `@@aka` marker, a `<think>` tag) off the line start where
 * the parsers anchor their match. Remaining C0/DEL controls are dropped. ESC
 * (0x1b), tab, newline and CR are preserved so ANSI stripping and line
 * structure still work downstream.
 */
export function normalizeControl(s: string): string {
  if (!/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/.test(s)) return s;
  let out = "";
  for (const ch of s) {
    if (ch === "\b") {
      // Don't erase across a line break — clamp at the start of the line.
      if (out.length && out[out.length - 1] !== "\n") out = out.slice(0, -1);
      continue;
    }
    out += ch;
  }
  return out.replace(/[\x00-\x07\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, "");
}

export function isNoise(line: string): boolean {
  if (STRUCTURED_LOG_RE.test(line)) return true;
  if (STACK_TRACE_RE.test(line)) return true;
  if (BUN_INTERNAL_FRAME_RE.test(line)) return true;
  if (JSON_CAUSE_RE.test(line)) return true;
  if (KV_FRAGMENT_RE.test(line)) return true;
  return false;
}
