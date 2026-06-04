/**
 * Wrapper-script stubs for the "plug-and-play any agent" path. When an agent
 * can't be expressed as a one-shot command (it's interactive, needs setup, or
 * only reads env vars), the user wraps it in a thin script that adapts AKA's
 * stable contract to whatever the agent expects. AKA generates the starter
 * stub; the user fills in the one line that launches their agent.
 *
 * The contract is the env block the Rust runner exports to EVERY agent
 * (`src-tauri/src/commands/agent_runner.rs`) — see WRAPPER_ENV.
 */

export type WrapperLang = "sh" | "python";

/** The environment AKA guarantees to every spawned agent / wrapper. */
export const WRAPPER_ENV = [
  ["AKA_MODEL", "the selected model id"],
  ["AKA_BASE_URL", "the LLM server base URL (also OPENAI_BASE_URL)"],
  ["AKA_API_KEY", "the API key, if any (also OPENAI_API_KEY)"],
  ["AKA_TASK", "the task prompt"],
  ["AKA_TASK_FILE", "a file containing the task prompt"],
  ["AKA_PROJECT_DIR", "the project root (also the working directory)"],
] as const;

const SH_STUB = `#!/usr/bin/env sh
# AKA agent wrapper.
# AKA runs this in your project directory and provides these env vars:
#   AKA_MODEL        the selected model id
#   AKA_BASE_URL     the LLM server base URL (also exported as OPENAI_BASE_URL)
#   AKA_API_KEY      the API key, if any (also exported as OPENAI_API_KEY)
#   AKA_TASK         the task prompt
#   AKA_TASK_FILE    a file containing the task prompt
#   AKA_PROJECT_DIR  the project root (also the working directory)
#
# Replace the line below with the command that launches your agent. Stream
# human-readable output to stdout; exit 0 on success, non-zero on failure.

exec your-agent --model "$AKA_MODEL" --message "$AKA_TASK"
`;

const PY_STUB = `#!/usr/bin/env python3
"""AKA agent wrapper.

AKA runs this in your project directory and provides these env vars:
  AKA_MODEL, AKA_BASE_URL, AKA_API_KEY, AKA_TASK, AKA_TASK_FILE, AKA_PROJECT_DIR
  (AKA_BASE_URL / AKA_API_KEY are also exported as OPENAI_BASE_URL / OPENAI_API_KEY)

Stream human-readable output to stdout; exit 0 on success, non-zero on failure.
"""
import os
import sys

model = os.environ.get("AKA_MODEL", "")
base_url = os.environ.get("AKA_BASE_URL", "")
task = os.environ.get("AKA_TASK", "")

# TODO: launch your agent here — call its Python API, or subprocess its CLI.
print(f"[wrapper] model={model} base_url={base_url}", flush=True)
print(task, flush=True)
sys.exit(0)
`;

/** Return a starter wrapper script in the requested language. */
export function wrapperStub(lang: WrapperLang): string {
  return lang === "python" ? PY_STUB : SH_STUB;
}

/** The command that invokes a saved wrapper at `path` (no exec bit needed). */
export function wrapperCommand(lang: WrapperLang, path: string): string {
  const runner = lang === "python" ? "python3" : "sh";
  // Quote the path so spaces survive; the task arrives via $AKA_TASK.
  return `${runner} "${path}"`;
}

/** Suggested filename for a generated wrapper. */
export function wrapperFilename(lang: WrapperLang): string {
  return lang === "python" ? "aka-agent-wrapper.py" : "aka-agent-wrapper.sh";
}
