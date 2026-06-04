import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, GitBranch } from "@phosphor-icons/react";
import { gitDiff } from "../../lib/tauri/commands";
import { useProjectsStore } from "../../stores/use-projects-store";
import { Tooltip } from "../Tooltip";

type DiffLine = {
  kind: "context" | "add" | "remove" | "hunk" | "fileheader";
  oldLine?: number;
  newLine?: number;
  text: string;
};

/**
 * Parse `git diff --no-color` unified-diff output into a flat list of rows the
 * table can render directly. Lightweight — handles hunk headers (`@@`) and
 * file headers (`diff --git`); ignores index/mode/binary lines.
 */
function parseUnifiedDiff(raw: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      // "diff --git a/foo b/bar" — surface the b-path as a section header.
      const m = line.match(/ b\/(.+)$/);
      out.push({ kind: "fileheader", text: m?.[1] ?? line });
      inHunk = false;
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("Binary files")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
        inHunk = true;
        out.push({ kind: "hunk", text: line });
      }
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      out.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      out.push({ kind: "remove", oldLine: oldLine++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      out.push({
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: line.slice(1),
      });
    }
    // Skip "\ No newline at end of file" and any other unknown lines.
  }

  return out;
}

export function DiffContent({ filePath }: { filePath?: string }) {
  const projectPath = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDiff = useCallback(async () => {
    if (!projectPath) {
      setLoading(false);
      setError("No active project");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const raw = await gitDiff(projectPath, filePath);
      setDiff(parseUnifiedDiff(raw));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDiff([]);
    } finally {
      setLoading(false);
    }
  }, [projectPath, filePath]);

  useEffect(() => {
    void fetchDiff();
  }, [fetchDiff]);

  const added = diff.filter((l) => l.kind === "add").length;
  const removed = diff.filter((l) => l.kind === "remove").length;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden font-mono text-[11px] leading-5">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/8 px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-[10px] text-white/45">
          <GitBranch size={11} weight="bold" className="shrink-0 text-white/35" />
          {filePath ?? "working tree vs HEAD"}
        </span>
        <div className="flex shrink-0 items-center gap-2 text-[10px] font-semibold">
          <span className="text-emerald-400">+{added}</span>
          <span className="text-red-400">−{removed}</span>
          <Tooltip label="Refresh diff" side="bottom">
            <button
              onClick={() => void fetchDiff()}
              disabled={loading}
              className="flex h-6 w-6 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white/85 disabled:opacity-30"
              aria-label="Refresh diff"
            >
              <ArrowClockwise
                size={11}
                weight="bold"
                className={loading ? "animate-spin" : ""}
              />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-white/30">
            Loading diff…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="text-sm text-amber-200/80">{error}</div>
            <div className="text-[11px] text-white/40">
              The Diff pane needs a git-initialised project to compare working
              tree against HEAD.
            </div>
          </div>
        ) : diff.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <div className="text-sm text-white/40">
              No changes vs HEAD
            </div>
            <div className="text-[11px] text-white/25">
              Edits made by the agent will appear here.
            </div>
          </div>
        ) : (
          <table className="min-w-full border-collapse">
            <colgroup>
              <col style={{ width: "2.25rem" }} />
              <col style={{ width: "2.25rem" }} />
              <col style={{ width: "1rem" }} />
              <col />
            </colgroup>
            <tbody>
              {diff.map((line, i) => {
                if (line.kind === "fileheader") {
                  return (
                    <tr key={i}>
                      <td
                        colSpan={4}
                        className="border-t border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/55"
                      >
                        {line.text}
                      </td>
                    </tr>
                  );
                }
                if (line.kind === "hunk") {
                  return (
                    <tr key={i}>
                      <td
                        colSpan={4}
                        className="bg-white/[0.02] px-3 py-0.5 text-[10px] text-white/35"
                      >
                        {line.text}
                      </td>
                    </tr>
                  );
                }
                const isAdd = line.kind === "add";
                const isRem = line.kind === "remove";
                const rowBg = isAdd
                  ? "bg-emerald-500/12"
                  : isRem
                    ? "bg-red-500/10"
                    : "";
                const codeColor = isAdd
                  ? "text-emerald-300"
                  : isRem
                    ? "text-red-300"
                    : "text-white/70";
                const symbol = isAdd ? "+" : isRem ? "−" : "";
                const symbolColor = isAdd
                  ? "text-emerald-400 font-bold"
                  : isRem
                    ? "text-red-400 font-bold"
                    : "";
                return (
                  <tr key={i} className={rowBg}>
                    <td className="select-none whitespace-nowrap px-2 text-right text-[10px] text-white/20">
                      {line.oldLine ?? ""}
                    </td>
                    <td className="select-none whitespace-nowrap px-2 text-right text-[10px] text-white/20">
                      {line.newLine ?? ""}
                    </td>
                    <td className={`select-none text-center text-[10px] ${symbolColor}`}>
                      {symbol}
                    </td>
                    <td className={`whitespace-pre px-2 ${codeColor}`}>
                      {line.text || " "}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
