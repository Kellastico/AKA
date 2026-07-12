/**
 * Approval policy for the built-in Execute loop (None agent + Execute mode).
 *
 * The model is offered the full phase-gated toolset; this module decides which
 * calls must PAUSE for the user's explicit approval before the enforced host
 * command runs. Pure — no store, no Tauri — so the policy is unit-testable and
 * the chat store just asks it questions.
 *
 * Three modes, mirroring the pattern users know from other coding agents:
 *   - "ask"         → every file edit and every shell command asks first.
 *   - "acceptEdits" → file edits run automatically; shell commands still ask.
 *   - "auto"        → nothing asks; edits stay checkpointed and undoable.
 *
 * Reads (read_file / list_dir / search_files / diagnostics) never ask in any
 * mode — they're the loop's read-only floor.
 */

export type ApprovalMode = "ask" | "acceptEdits" | "auto";

/** What a gated tool is about to do — the unit approval is granted per. */
export type ApprovalGate = "edit" | "exec";

export const APPROVAL_MODES: {
  id: ApprovalMode;
  label: string;
  hint: string;
}[] = [
  {
    id: "ask",
    label: "Ask first",
    hint: "Every file edit and shell command pauses for your approval",
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    hint: "File edits run automatically; shell commands still ask",
  },
  {
    id: "auto",
    label: "Auto",
    hint: "Edits and shell commands run without asking (checkpointed, undoable)",
  },
];

export const KNOWN_APPROVAL_MODES: ApprovalMode[] = APPROVAL_MODES.map((m) => m.id);

/** Coerce a persisted string back to a valid mode ("ask" is the safe floor). */
export function parseApprovalMode(s: string | null | undefined): ApprovalMode {
  return (KNOWN_APPROVAL_MODES as string[]).includes(s ?? "")
    ? (s as ApprovalMode)
    : "ask";
}

/**
 * The approval gate a built-in tool call falls under, or `null` for the
 * read-only tools that never ask. Names are the shared catalog's.
 */
export function approvalGateFor(toolName: string): ApprovalGate | null {
  switch (toolName) {
    case "str_replace":
    case "apply_diff":
    case "delete_file":
      return "edit";
    case "bash":
      return "exec";
    default:
      return null;
  }
}

/** Whether a call under `gate` must pause for the user in `mode`. */
export function needsApproval(mode: ApprovalMode, gate: ApprovalGate): boolean {
  if (mode === "auto") return false;
  if (mode === "acceptEdits") return gate === "exec";
  return true; // "ask"
}

/** A tool call's parsed `arguments`; `{}` when the JSON was malformed. */
export type ToolArgs = Record<string, unknown>;

/** Parse a tool call's raw `arguments` JSON once, tolerating malformed input. */
export function parseToolArgs(argumentsJson: string): ToolArgs {
  try {
    return JSON.parse(argumentsJson) as ToolArgs;
  } catch {
    return {};
  }
}

/** Read a string field from parsed args, or `""` when absent/non-string. */
export function stringArg(args: ToolArgs, key: string): string {
  return typeof args[key] === "string" ? (args[key] as string) : "";
}

/**
 * The one-line prompt shown on the approval card for a gated call — concrete
 * (the exact command / target file), so the user knows what they're approving.
 * Takes already-parsed args (see {@link parseToolArgs}) so the loop parses the
 * raw JSON exactly once per call.
 */
export function approvalPrompt(toolName: string, args: ToolArgs): string {
  const s = (k: string) => stringArg(args, k);
  switch (toolName) {
    case "bash":
      return `Run: ${s("command") || "(empty command)"}`;
    case "str_replace":
      return `Edit file: ${s("path") || "(unknown path)"}`;
    case "apply_diff": {
      const files = diffPaths(s("patch"));
      return files.length > 0
        ? `Apply patch to: ${files.join(", ")}`
        : "Apply patch";
    }
    case "delete_file":
      return `Delete file: ${s("path") || "(unknown path)"}`;
    default:
      return `Run tool: ${toolName}`;
  }
}

/**
 * Every distinct file a unified diff touches, mirroring the backend's
 * `extract_diff_paths` (src-tauri/src/sandbox.rs): reads BOTH `---` and `+++`
 * headers, strips a conventional `a/`/`b/` prefix, drops `/dev/null` sentinels.
 * So the approval card names exactly the files the enforced `apply_diff` will
 * validate and change — a deletion hunk (`+++ /dev/null`) still surfaces its
 * real target from the `---` side rather than degrading to a generic label.
 */
function diffPaths(patch: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of patch.split("\n")) {
    const raw = line.startsWith("--- ")
      ? line.slice(4)
      : line.startsWith("+++ ")
        ? line.slice(4)
        : null;
    if (raw === null) continue;
    const trimmed = raw.split("\t")[0].trim();
    if (!trimmed || trimmed === "/dev/null") continue;
    const stripped = trimmed.replace(/^[ab]\//, "");
    if (stripped && !seen.has(stripped)) {
      seen.add(stripped);
      out.push(stripped);
    }
  }
  return out;
}
