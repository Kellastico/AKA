/**
 * Registry of recognised stderr patterns and the shell commands that fix
 * them. Each entry is a small, deterministic remediation — no AI involved —
 * so the user can trust the button label = exactly what will run.
 *
 * Adding a new fix: write a `match` predicate that returns true only when
 * the fix is genuinely safe, then describe the commands in plain English
 * for the confirmation sheet. Keep `commands` minimal — a failed step
 * aborts the rest (we join with `&&` at run time).
 */

import { extractBusyPort, isPortInUseError } from "./humanize-error";

export type ErrorFix = {
  /** Stable id for analytics + tests. */
  id: string;
  /** Returns true if this fix is appropriate for the given stderr. */
  match: (stderr: string) => boolean;
  /** Short title — shown as the auto-fix button label and in the confirm sheet. */
  title: string;
  /** What the fix will do, in one or two plain-English sentences. */
  description: string;
  /** Shell commands, run sequentially via `&&` in the project's sandbox. */
  commands: string[];
  /** Optional: what the user needs installed for the fix to work. */
  requires?: string;
  /**
   * Optional hook for fixes whose commands depend on values captured from the
   * stderr at match time (e.g. a PID). Returns overrides for `title` and/or
   * `commands`; `findFix` merges these into the resolved fix. Static fixes
   * leave this unset.
   */
  dynamic?: (stderr: string) => Partial<Pick<ErrorFix, "title" | "commands">>;
};

export const ERROR_FIXES: ErrorFix[] = [
  {
    id: "libressl-python",
    match: (s) =>
      /NotOpenSSLWarning/.test(s) && /LibreSSL/.test(s),
    title: "Replace macOS Python with OpenSSL-linked Python",
    description:
      "macOS ships Python linked against LibreSSL, which urllib3 v2 warns about. This installs Python 3.12 from Homebrew (which uses real OpenSSL). Reinstall your Python-based agent against it afterwards to silence the warning.",
    commands: [
      "brew install python@3.12",
    ],
    requires: "Homebrew",
  },
  {
    id: "next-orphan-dev-server",
    // Next.js itself names the offender in stderr — we only offer the fix
    // when both the marker phrase AND a parseable PID are present, so the
    // `kill` command we hand to the user is never a placeholder.
    match: (s) =>
      /Another next dev server is already running/i.test(s) &&
      /PID:\s*\d+/.test(s),
    title: "Stop the orphan Next.js dev server",
    description:
      "A previous `next dev` from this project is still running and Next.js refuses to start a second one. This kills the orphan by PID so the next Start runs cleanly.",
    // Placeholder — `dynamic` rewrites this with the captured PID before
    // the confirm sheet renders.
    commands: ["kill <pid>"],
    requires: "kill",
    dynamic: (stderr) => {
      const pid = stderr.match(/PID:\s*(\d+)/)?.[1];
      if (!pid) return {};
      return {
        title: `Stop the orphan Next.js dev server (PID ${pid})`,
        // Try a graceful SIGTERM first; fall back to SIGKILL if Next is
        // wedged. `2>/dev/null` keeps "no such process" out of the log when
        // the first kill already succeeded.
        commands: [`kill ${pid} 2>/dev/null || kill -9 ${pid}`],
      };
    },
  },
  {
    // NB id is kept as "port-in-use-8000" for back-compat (analytics + tests),
    // but the fix is no longer 8000-specific: the `dynamic` hook below rewrites
    // the command to target whatever port the failure actually names (Vite's
    // 5173/5174, a Node EADDRINUSE address, etc.), falling back to 8000 only
    // when the error carries no port (e.g. Python's bare "[Errno 48]").
    id: "port-in-use-8000",
    // Match Python's socketserver OSError, Node's EADDRINUSE, the generic
    // "address already in use" phrasing, AND Vite/webpack's "Port N is already
    // in use" — `isPortInUseError` is the single source of truth (it also
    // excludes the Next-orphan case, which has its own dedicated fix above).
    match: (s) => isPortInUseError(s),
    title: "Free the busy port",
    description:
      "Another process is holding the port your dev server wants. This finds whatever's listening on it and force-kills it, then you can hit Start again.",
    // Placeholder — `dynamic` rewrites this with the real port before the
    // confirm sheet renders. `kill -9 $(lsof -ti :PORT)` fails loudly when
    // nothing's on the port; `|| true` swallows that so the command always
    // succeeds and the final echo confirms the state.
    commands: [
      "kill -9 $(lsof -ti :8000) 2>/dev/null || true; echo 'Port 8000 is now free'",
    ],
    requires: "lsof",
    dynamic: (stderr) => {
      const port = extractBusyPort(stderr) ?? 8000;
      return {
        title: `Free port ${port}`,
        commands: [
          `kill -9 $(lsof -ti :${port}) 2>/dev/null || true; echo 'Port ${port} is now free'`,
        ],
      };
    },
  },
  {
    id: "git-not-initialised",
    match: (s) => /not a git repository/i.test(s),
    title: "Initialise this folder as a git repository",
    description:
      "Runs `git init`, stages every existing file, and makes an initial commit so the Diff pane and any future agent edits have a baseline to compare against.",
    commands: [
      "git init",
      "git add -A",
      "git commit -m 'Initial commit (created by AKA auto-fix)'",
    ],
    requires: "git",
  },
];

/**
 * Find the first registered fix that matches this stderr, or null. For
 * entries with a `dynamic` hook, the captured overrides (e.g. a PID-bearing
 * `kill` command) are merged in before the fix reaches the UI, so callers
 * always see fully-resolved title/commands.
 */
export function findFix(stderr: string): ErrorFix | null {
  const raw = ERROR_FIXES.find((f) => f.match(stderr));
  if (!raw) return null;
  if (!raw.dynamic) return raw;
  return { ...raw, ...raw.dynamic(stderr) };
}
