import { NotePencil } from "@phosphor-icons/react";
import type { Message, ToolKind } from "../../stores/use-messages-store";
import { CodeText } from "../../lib/syntax-highlight";

/**
 * Trim a phrase to at most `max` words. The agent's active-state line is a
 * glanceable status, never a paragraph — the spec caps it at 25 words, so
 * anything longer gets clipped with a trailing ellipsis.
 */
export function clampWords(text: string, max = 25): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= max) return trimmed;
  return words.slice(0, max).join(" ") + "…";
}

/** Basename for compact display ("src/a/b/c.tsx" → "c.tsx"). */
export function baseName(path?: string): string | undefined {
  if (!path) return undefined;
  const clean = path.replace(/[\\/]+$/, "");
  const seg = clean.split(/[\\/]/).pop();
  return seg && seg.length > 0 ? seg : clean;
}

/**
 * Per-file roll-up across a run of tool messages. Lets the accordion answer
 * the question "which files did the agent actually touch?" at a glance,
 * without forcing the user to scan every individual tool row.
 *
 * Grouped by `toolPath` (unique key) — a single file written-then-read shows
 * up once with both kinds set. Diff stats are summed across all ops on the
 * same file. Tool rows without a path (e.g. `list_projects`, generic shell)
 * are deliberately excluded from this view since there's no file to show.
 */
export type FileRollup = {
  path: string;
  kinds: ToolKind[];
  linesAdded: number;
  linesRemoved: number;
  count: number;
};

const KIND_RANK: Record<ToolKind, number> = {
  write: 0,
  run: 1,
  search: 2,
  read: 3,
};

export function rollupFiles(
  messages: { toolKind?: ToolKind; toolPath?: string; linesAdded?: number; linesRemoved?: number }[],
): FileRollup[] {
  const map = new Map<string, FileRollup>();
  for (const m of messages) {
    if (!m.toolPath || !m.toolKind) continue;
    const existing = map.get(m.toolPath);
    if (existing) {
      if (!existing.kinds.includes(m.toolKind)) existing.kinds.push(m.toolKind);
      existing.linesAdded += m.linesAdded ?? 0;
      existing.linesRemoved += m.linesRemoved ?? 0;
      existing.count += 1;
    } else {
      map.set(m.toolPath, {
        path: m.toolPath,
        kinds: [m.toolKind],
        linesAdded: m.linesAdded ?? 0,
        linesRemoved: m.linesRemoved ?? 0,
        count: 1,
      });
    }
  }
  // Sort kinds so the dominant action (write > run > search > read) is
  // first — drives both the file's accent colour and verb in the panel.
  for (const r of map.values()) {
    r.kinds.sort((a, b) => KIND_RANK[a] - KIND_RANK[b]);
  }
  return [...map.values()];
}

/**
 * Section labels for an expanded tool panel, named for what the tool actually
 * did so the user reads "Query / Results" or "Command / Output" rather than a
 * generic "Input / Output". (`write` is handled separately as a diff.)
 */
export function toolIOLabels(kind?: ToolKind): { input: string; output: string } {
  switch (kind) {
    case "search":
      return { input: "Query", output: "Results" };
    case "read":
      return { input: "Arguments", output: "Contents" };
    case "run":
      return { input: "Command", output: "Output" };
    default:
      return { input: "Input", output: "Output" };
  }
}

/** English verb for a tool kind, used in the Files-touched panel ("Edited"). */
export function verbForKind(kind: ToolKind): string {
  switch (kind) {
    case "write":
      return "Edited";
    case "read":
      return "Read";
    case "search":
      return "Searched";
    case "run":
      return "Ran";
  }
}

/**
 * A short, present-tense phrase describing what a tool is doing *right now*.
 * Rendered while a tool row is "running" (and surfaced in the accordion
 * header so the user sees it without expanding). Capped at 25 words.
 *
 * Agent-agnostic by construction: derived purely from the tool's
 * kind / name / path, so it reads identically no matter which agent
 * produced the call — AKA never assumes a specific agent.
 */
export function activeSummary(message: {
  toolKind?: Message["toolKind"];
  toolName?: string;
  toolPath?: string;
}): string {
  const where = baseName(message.toolPath);
  const name = message.toolName;
  switch (message.toolKind) {
    case "write":
      return clampWords(where ? `Writing changes to ${where}` : "Writing changes");
    case "read":
      return clampWords(where ? `Reading ${where}` : "Reading file");
    case "search":
      return clampWords(where ? `Searching ${where}` : "Searching the workspace");
    case "run":
      return clampWords(name ? `Running ${name}` : "Running command");
    default:
      return clampWords(name ? `Working · ${name}` : "Working");
  }
}

/* ── edit-diff parsing + render ───────────────────────────────────────────
 * AKA stores a tool's *input* (the agent's search/replace payload), not a
 * pre-computed unified diff. For `write` tools we reconstruct a before/after
 * view from that input so an `edit_file` row can show exactly what changed —
 * red removed lines, green added lines, and nothing else. Agent-agnostic by
 * construction: we probe the common key shapes every agent uses rather than
 * assuming one specific tool format.
 */

const OLD_KEYS = ["old_string", "old", "search", "before", "find", "original", "old_str"];
const NEW_KEYS = [
  "new_string", "new", "replace", "after", "replacement", "new_str", "content", "text", "code",
];

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

export type EditDiff = { removed: string[]; added: string[] };

/**
 * Best-effort before/after extraction from a `write` tool's input. Handles the
 * JSON search/replace shape (old_string/new_string and its many synonyms) and
 * whole-file writes (content/text only → all-added). Returns null when the
 * input carries nothing diffable, so the caller can fall back to the raw input.
 */
export function parseEditDiff(input?: string): EditDiff | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const oldStr = firstString(obj, OLD_KEYS);
      const newStr = firstString(obj, NEW_KEYS);
      if (oldStr !== undefined || newStr !== undefined) {
        return {
          removed: oldStr !== undefined ? splitLines(oldStr) : [],
          added: newStr !== undefined ? splitLines(newStr) : [],
        };
      }
    } catch {
      // not valid JSON — fall through
    }
  }
  return null;
}

/** Cap a diff so a giant edit can't blow out the timeline; note the remainder. */
const MAX_DIFF_LINES = 60;

/**
 * The expanded body of an `edit_file` (write) tool row: a compact hunk header
 * (`file · +N −N`) followed by the colour-coded diff and nothing else. Counts
 * prefer the agent-reported `linesAdded`/`linesRemoved`, falling back to the
 * parsed line totals. When no before/after can be parsed we still honour
 * "diffs only" by rendering the raw input as added context.
 */
export function DiffView({
  path,
  input,
  linesAdded,
  linesRemoved,
}: {
  path?: string;
  input?: string;
  linesAdded?: number;
  linesRemoved?: number;
}) {
  const parsed = parseEditDiff(input);
  const removed = parsed?.removed ?? [];
  const added = parsed?.added ?? (parsed ? [] : input ? splitLines(input) : []);
  const addN = linesAdded ?? added.length;
  const remN = linesRemoved ?? removed.length;

  const rows: { sign: "-" | "+"; text: string }[] = [
    ...removed.map((text) => ({ sign: "-" as const, text })),
    ...added.map((text) => ({ sign: "+" as const, text })),
  ];
  const shown = rows.slice(0, MAX_DIFF_LINES);
  const overflow = rows.length - shown.length;

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10.5px] text-ink/45">
        <NotePencil size={11} className="shrink-0 text-ink/40" />
        <span className="truncate">{baseName(path) ?? "edit"}</span>
        <span className="text-ink/25">·</span>
        <span className="text-emerald-300/90">+{addN}</span>
        <span className="text-red-300/90">−{remN}</span>
      </div>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          {shown.map((r, i) => (
            <div
              key={i}
              className={[
                "whitespace-pre-wrap rounded-sm px-1.5 font-mono text-[11px] leading-[1.55] [overflow-wrap:anywhere]",
                // The +/- gutter keeps its add/remove tint; the code itself is
                // syntax-colored so an edit reads as code, not a flat line.
                r.sign === "-" ? "bg-red-500/10" : "bg-emerald-500/10",
              ].join(" ")}
            >
              <span className={r.sign === "-" ? "text-red-300/80" : "text-emerald-300/80"}>
                {r.sign}{" "}
              </span>
              <CodeText text={r.text} />
            </div>
          ))}
          {overflow > 0 && (
            <div className="mt-1 px-1.5 font-mono text-[10.5px] text-ink/35">
              … {overflow} more line{overflow === 1 ? "" : "s"}
            </div>
          )}
        </div>
      ) : (
        <span className="font-mono text-[11px] text-ink/40">No diff detail.</span>
      )}
    </div>
  );
}

/**
 * Accessible diff-stat chip. Instead of a terse "+3 −2", the visible text
 * spells out "+12 code added | −3 code removed" and carries a full
 * screen-reader label. `compact` drops the words ("+12 | −3") for tight
 * spots like the accordion header while keeping the descriptive aria-label.
 */
export function DiffStat({
  added,
  removed,
  compact = false,
}: {
  added?: number;
  removed?: number;
  compact?: boolean;
}) {
  if (added === undefined && removed === undefined) return null;
  const a = added ?? 0;
  const r = removed ?? 0;
  const label = `${a} ${a === 1 ? "line" : "lines"} of code added, ${r} ${
    r === 1 ? "line" : "lines"
  } of code removed`;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-ink/5 px-1.5 py-0.5 font-mono tabular-nums"
      aria-label={label}
      title={label}
    >
      {added !== undefined && (
        <span className="text-emerald-300/90">
          +{a}
          {compact ? "" : " code added"}
        </span>
      )}
      {added !== undefined && removed !== undefined && (
        <span className="text-ink/25">|</span>
      )}
      {removed !== undefined && (
        <span className="text-red-300/90">
          −{r}
          {compact ? "" : " code removed"}
        </span>
      )}
    </span>
  );
}
