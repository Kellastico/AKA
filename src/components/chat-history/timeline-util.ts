import { useEffect, useState } from "react";

/**
 * Re-render on a 1s cadence while `active` is true, then stop. Lets a node's
 * elapsed timer tick live during a run and freeze the instant it settles —
 * without every caller hand-rolling its own interval.
 */
export function useTicker(active: boolean): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/** Format a whole duration as "812ms" / "4.2s" / "7m 6s" (no ms past 1s). */
export function fmtClock(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Approximate token count from a character count using the chars/4 heuristic
 * AKA already uses in lieu of a real tokenizer in the WebView (see the Rust
 * `count_tokens` command + the live tokens/sec meters). Formatted "812" /
 * "3.4k" so the run footer reads like the reference ("3.4k tokens").
 */
export function approxTokens(chars: number): string {
  const tokens = Math.round(chars / 4);
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}
