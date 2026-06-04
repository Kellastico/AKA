import type { Message, ToolKind } from "../../stores/use-messages-store";

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
