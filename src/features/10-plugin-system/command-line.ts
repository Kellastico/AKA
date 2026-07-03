/**
 * Split the panel's single "command line" input into the `command` + `args`
 * the Rust side spawns directly (no shell). Whitespace-separated, with
 * single/double-quote grouping so `npx -y "@scope/some server"` works; no
 * escapes, expansions, or pipes — this is not a shell, by design (the value
 * is spawned as an argv, never run through `sh`).
 */
export function parseCommandLine(input: string): { command: string; args: string[] } | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) return null; // unbalanced quote
  if (hasToken) tokens.push(current);

  if (tokens.length === 0) return null;
  return { command: tokens[0], args: tokens.slice(1) };
}

/** Re-join a saved server's command + args for display in the panel. */
export function formatCommandLine(command: string, args: string[]): string {
  const quoteIfNeeded = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  return [command, ...args].map(quoteIfNeeded).join(" ");
}
