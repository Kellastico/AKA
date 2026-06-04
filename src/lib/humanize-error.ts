/**
 * Translate raw process stderr into a short, plain-English `{title, hint}`
 * the user can act on. AKA owns this translation layer — agents and dev
 * servers produce technical output, AKA presents it like a UI element.
 *
 * Rules are matched in order; the FIRST rule that hits wins. Order from
 * most-specific to most-generic. Adding a rule: keep the title under ~60
 * chars and write the hint like you'd explain it to a non-engineer.
 */

export type ErrorExplanation = {
  /** Short, ~one-line title. Shown bold above the stderr block. */
  title: string;
  /** Longer hint, one-to-three sentences. Explain *what to do*. */
  hint: string;
};

const RULES: Array<{
  match: RegExp;
  build: (m: RegExpMatchArray) => ErrorExplanation;
}> = [
  {
    // Ollama: "model" does not support thinking (status code: 400)
    // Also catches langchain_anthropic / openai / litellm variants that use
    // "extended_thinking", "thinking mode", or "reasoning mode" in the message.
    match: /does not support (?:thinking|extended[_\s]thinking|reasoning mode)/i,
    build: () => ({
      title: "Model doesn't support thinking mode",
      hint:
        "Your agent requested thinking/reasoning mode, but the active model doesn't support it. " +
        "Switch to a model that does (e.g. a Qwen3 or Deepseek-R1 variant in Ollama), or " +
        "remove the thinking flag from your agent's configuration.",
    }),
  },
  {
    // Specific bug we hit when an agent's args don't have {task} — the prompt
    // gets passed as a positional arg, which agents treat as a file path.
    match: /OSError:\s*\[Errno 63\]\s*File name too long/,
    build: () => ({
      title: "The agent received your prompt as a file path",
      hint:
        "Your agent's saved args don't tell it where to inject the prompt, so AKA appended it as a positional argument — which the agent treated as a filename. Add a `{task}` placeholder to your agent's args (where the prompt should go); AKA fills it in at runtime instead of appending it positionally.",
    }),
  },
  {
    match: /EOFError:\s*EOF when reading a line/,
    build: () => ({
      title: "The agent tried to ask a question on stdin",
      hint:
        "The agent expected a Y/N answer from a terminal, but AKA runs it as a pipe. Add your agent's auto-confirm / non-interactive flag (e.g. a `--yes`-style flag) to its args so it doesn't block waiting for input.",
    }),
  },
  {
    match: /ENOENT.*package\.json/,
    build: () => ({
      title: "No package.json in this folder",
      hint:
        "npm needs a `package.json` to run. This folder isn't a Node project — for static HTML use `python3 -m http.server 8000` as your dev-server command instead (the Configure modal can auto-detect it).",
    }),
  },
  {
    match: /fatal: not a git repository/i,
    build: () => ({
      title: "This folder isn't a git repository",
      hint:
        "The Diff pane and any agent that uses git need a `.git` directory. Run `git init` from the Console terminal, or use the Auto-fix button below.",
    }),
  },
  {
    match: /Permission denied/,
    build: () => ({
      title: "Permission denied",
      hint:
        "The agent couldn't read or write a file. Check that the path is inside your project sandbox and that your OS account has access to it.",
    }),
  },
  {
    // Generic "command not found" — covers the three real-world formats
    // the stress test caught the previous regex missing:
    //   zsh:    "zsh: command not found: aider"      (binary after phrase)
    //   bash:   "bash: aider: command not found"     (binary before phrase)
    //   env:    "env: 'aider': No such file..."      (env-style exec failure)
    // Order matters: the zsh form must be tried before the bash form,
    // otherwise the bash alt greedily captures the shell name ("zsh") as the
    // binary. Each alt writes into its own group; build picks the first
    // non-empty one.
    match:
      /(?:command not found:\s*(\S+)|([^\s:]+):\s*command not found(?!:)|(?:[^\s:]+):\s*'?([^'\s]+)'?:\s*No such file or directory)/i,
    build: (m) => {
      const bin = m[1] ?? m[2] ?? m[3] ?? "the binary";
      return {
        title: `${bin} isn't installed`,
        hint: `The binary "${bin}" wasn't found on your PATH. Install it via your package manager, then retry.`,
      };
    },
  },
  {
    match: /NotOpenSSLWarning/,
    build: () => ({
      title: "Cosmetic warning — Python uses LibreSSL",
      hint:
        "macOS's bundled Python links against LibreSSL instead of OpenSSL. urllib3 v2 complains but the agent still works. Auto-fix below will swap it for Homebrew's OpenSSL-linked Python.",
    }),
  },
  {
    // Next.js 13+ self-detects a duplicate `next dev` for the same project
    // and refuses to run a second instance, *even after* it rolled forward
    // to a free port. Distinct from EADDRINUSE — the new process started
    // fine, then exited because of Next's own internal sentinel file. The
    // remediation is to kill the orphan by PID, not to free a port.
    match: /Another next dev server is already running[\s\S]*?PID:\s*(\d+)/,
    build: (m) => ({
      title: "A previous Next.js dev server is still running",
      hint: `Next.js refuses to run a second \`next dev\` for the same project. The orphan is PID ${m[1]} — kill it (\`kill ${m[1]}\`) or use the auto-fix button below.`,
    }),
  },
  {
    // Port already in use — every common runtime form:
    //   Node:    "EADDRINUSE", "address already in use 127.0.0.1:5173"
    //   Python:  "[Errno 48]/[Errno 98] Address already in use"
    //   Vite/    "Port 5174 is already in use" (also Webpack/Astro/etc.)
    //   webpack
    // NB the Vite form requires the word "already" so it does NOT collide
    // with Next.js's "Port 3000 is in use by process … using available port"
    // line — that one is handled by the more specific Next-orphan rule above.
    match:
      /address already in use|EADDRINUSE|\[Errno (?:48|98)\] Address already in use|Port \d+ is already in use/i,
    build: (m) => {
      const port = extractBusyPort(m.input ?? "");
      return {
        title: port ? `Port ${port} is already in use` : "That port is already in use",
        hint: port
          ? `Another process is still holding port ${port} — usually a dev server from an earlier run that didn't shut down. Use the “Free port ${port} & restart” button below and AKA will stop it and relaunch for you.`
          : "Another process is already listening on this port — usually a dev server from an earlier run that didn't shut down. Use the button below to free the port and restart, or change the port in your dev-server command.",
      };
    },
  },
  {
    // Generic "CLI rejected the args and dumped its help text" pattern.
    // Matches the canonical yargs-style header used by opencode + most
    // node/python CLIs. The signal that the *help screen* came back (as
    // opposed to a normal error) is the `Positionals:` line near the top.
    match: /Positionals:\s*\n.*Options:\s*\n.*-h,\s*--help/s,
    build: () => ({
      title: "The agent rejected the command-line arguments",
      hint:
        "The agent printed its `--help` output instead of running, which means one of the flags AKA passed isn't valid for the installed version. Re-select the agent from the picker to refresh its args, or run the agent's own --help in the Console to see what changed.",
    }),
  },
  {
    // Some agents wrap a client (e.g. litellm) that needs a provider prefix on
    // the model name. Comes up when the model is passed without one.
    match: /LLM Provider NOT provided/i,
    build: () => ({
      title: "The agent doesn't know which LLM provider to use",
      hint:
        "The agent's underlying client needs a provider prefix on the model name (e.g. `openai/gemma4:e4b` or `ollama/qwen2.5-coder:7b`). AKA passes your model through unchanged, so add the prefix to your model name or to your agent's `--model` argument.",
    }),
  },
  {
    // Some agents keep their own provider registry and won't route to a model
    // unless it's been declared there — even with the right prefix. Catches
    // both the JSON error tag and the friendlier "Did you mean: …" line.
    match: /ProviderModelNotFoundError|Model not found:.*Did you mean/i,
    build: () => ({
      title: "This agent doesn't have the model registered",
      hint:
        "This agent only routes to models declared in its own configuration, so even a correct provider prefix isn't enough. Register the model in that agent's config, or use an agent that accepts any model your LLM server exposes.",
    }),
  },
];

export function humanizeError(stderr: string): ErrorExplanation | null {
  const trimmed = stderr.trim();
  if (!trimmed) return null;
  for (const rule of RULES) {
    const m = trimmed.match(rule.match);
    if (m) return rule.build(m);
  }
  return null;
}

/**
 * True when the dev-server output looks like a port-already-in-use failure.
 * Covers Node (EADDRINUSE), Python ([Errno 48]/[Errno 98]), the generic
 * cross-runtime "address already in use" phrasing, and the Vite/webpack
 * "Port N is already in use" wording. The Preview pane gates its
 * "Free port & restart" button (and the store's auto-recovery) on this — we
 * only want to free/kill a port when the failure is actually about a port
 * being held.
 *
 * The Next.js orphan case is explicitly excluded: Next prints "Port 3000 is
 * in use … using available port 3001" then rolls forward and quits for an
 * unrelated reason (its own sentinel file). Killing the URL-bar port wouldn't
 * help there, so that scenario is handled by the dedicated Next-orphan fix.
 */
export function isPortInUseError(stderr: string): boolean {
  if (/Another next dev server is already running/i.test(stderr)) return false;
  return (
    /EADDRINUSE/.test(stderr) ||
    /\[Errno (?:48|98)\] Address already in use/.test(stderr) ||
    /address already in use/i.test(stderr) ||
    /Port \d+ is already in use/i.test(stderr)
  );
}

/** Clamp a parsed string to a valid TCP port, or null. */
function asValidPort(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Pull the conflicting port number out of a dev-server failure, so the UI can
 * offer "Free port <N> & restart" and the store can auto-kill the *exact*
 * port that's blocking the launch (not whatever the URL bar happens to show).
 *
 * Handles the common shapes:
 *   Vite/webpack:  "Port 5174 is already in use"
 *   Node net:      "EADDRINUSE: address already in use 127.0.0.1:5173"
 *                  "EADDRINUSE: address already in use :::3000"
 *
 * Python's "[Errno 48] Address already in use" carries no port in the
 * message, so this returns null there and callers fall back to the URL bar.
 */
export function extractBusyPort(stderr: string): number | null {
  const vite = stderr.match(/Port (\d+) is already in use/i);
  if (vite) return asValidPort(vite[1]);

  // Node prints the address right after the phrase: "…in use 127.0.0.1:5173"
  // or "…in use :::3000". Grab the digits after the final colon on that span.
  const node = stderr.match(/(?:EADDRINUSE|address already in use)[^\n]*?:(\d{2,5})\b/i);
  if (node) return asValidPort(node[1]);

  return null;
}
