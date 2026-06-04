/**
 * Command ⇄ argv conversion for agent registration.
 *
 * AKA registers an agent as `{ bin, args }`, but asking the user to hand-author
 * an argv array is the friction we're removing. Instead the UI lets them paste
 * the command they'd run in a terminal; this module is the single source of
 * truth for turning that string into `{ bin, args }` and back.
 *
 * `parseCommand` is a *splitter*, not a shell: it groups single/double quotes
 * and honours backslash escapes, but does NO variable expansion, globbing, or
 * operator handling. Placeholders like `{model}` / `{base_url}` / `{task}` are
 * ordinary characters and pass through untouched.
 */

export type ParsedCommand = { bin: string; args: string[] };

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/**
 * Tokenize a shell-style command line into a bin + args the way a POSIX shell
 * would split it. Empty input (or whitespace only) yields `{ bin: "", args: [] }`.
 */
export function parseCommand(input: string): ParsedCommand {
  const tokens: string[] = [];
  let cur = "";
  // Tracks whether we've started a token — lets an explicit "" (from `''`)
  // become a real empty token, distinct from "no token here".
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === "\\" && i + 1 < input.length) {
        // Inside double quotes a backslash only escapes `"` and `\`; otherwise
        // it's literal (matches POSIX sh semantics closely enough for argv).
        const nxt = input[i + 1];
        if (nxt === '"' || nxt === "\\") {
          cur += nxt;
          i++;
        } else {
          cur += ch;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[i + 1];
      started = true;
      i++;
      continue;
    }
    if (WHITESPACE.has(ch)) {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);

  const [bin = "", ...args] = tokens;
  return { bin, args };
}

// A token is safe to leave unquoted when it's only made of characters a shell
// treats literally AND that we commonly see in agent commands: flags, paths,
// provider-prefixed models (`ollama/qwen`), and `{token}` placeholders.
const SAFE_TOKEN = /^[A-Za-z0-9_./:@%+,=~{}\-]+$/;

function quoteToken(token: string): string {
  if (token === "") return '""';
  if (SAFE_TOKEN.test(token)) return token;
  // Wrap anything else in double quotes, escaping `"` and `\` so it parses back
  // to exactly the same token.
  return `"${token.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Reassemble a `bin` + `args` into a single command line that round-trips
 * through `parseCommand`. Used to seed the command field when editing an
 * existing agent and when exporting a recipe. An empty `bin` yields "".
 */
export function formatCommand(bin: string, args: string[]): string {
  if (!bin) return "";
  return [bin, ...args].map(quoteToken).join(" ");
}

/** True when the command references the `{task}` placeholder anywhere. */
export function hasTaskPlaceholder(command: string): boolean {
  return command.includes("{task}");
}

/** True when the command references the `{model}` placeholder anywhere. */
export function hasModelPlaceholder(command: string): boolean {
  return command.includes("{model}");
}
