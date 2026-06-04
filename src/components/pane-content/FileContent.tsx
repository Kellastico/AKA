import React, { useEffect, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { readTextFile } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { Tooltip } from "../Tooltip";

// Cap how much of a file we render. Keeps the table fast on giant files;
// the agent's tools still operate on the whole file.
const MAX_LINES = 5000;

function highlight(line: string): React.ReactNode {
  if (!line.trim()) return <span> </span>;

  const parts: React.ReactNode[] = [];
  let rest = line;
  let key = 0;

  const push = (cls: string, text: string) =>
    parts.push(<span key={key++} className={cls}>{text}</span>);

  while (rest.length > 0) {
    const str = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/);
    if (str) { push("text-amber-300", str[0]); rest = rest.slice(str[0].length); continue; }

    const tag = rest.match(/^(<\/?[A-Z][A-Za-z0-9.]*|<\/?[a-z][a-z-]*)/);
    if (tag) { push("text-blue-400", tag[0]); rest = rest.slice(tag[0].length); continue; }

    const kw = rest.match(/^(import|export|default|from|const|let|var|return|function|typeof|interface|type|if|else|for|while|class|new|async|await|pub|fn|use|mod|struct|enum|impl|match|trait|self|Self)\b/);
    if (kw) { push("text-purple-400", kw[0]); rest = rest.slice(kw[0].length); continue; }

    const op = rest.match(/^(=>|&&|\?\?|\?\.|::)/);
    if (op) { push("text-purple-300", op[0]); rest = rest.slice(op[0].length); continue; }

    const prop = rest.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)(?==)/);
    if (prop) { push("text-sky-300", prop[0]); rest = rest.slice(prop[0].length); continue; }

    const num = rest.match(/^[0-9]+/);
    if (num) { push("text-teal-300", num[0]); rest = rest.slice(num[0].length); continue; }

    const chunk = rest.match(/^[^"'`<a-zA-Z_$0-9\n]+|^./);
    if (chunk) { push("text-white/65", chunk[0]); rest = rest.slice(chunk[0].length); continue; }

    break;
  }
  return <>{parts}</>;
}

function relativePath(path: string): string {
  // Show last two segments to fit narrow panes without losing context.
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}

export function FileContent({
  paneId,
  filePath,
}: {
  paneId?: string;
  filePath?: string;
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showFilesInPane = useWorkspaceStore((s) => s.showFilesInPane);

  useEffect(() => {
    setLines(null);
    setTruncated(false);
    setError(null);
    if (!filePath) return;
    let alive = true;
    readTextFile(filePath)
      .then((payload) => {
        if (!alive) return;
        const allLines = payload.contents.split("\n");
        if (allLines.length > MAX_LINES) {
          setLines(allLines.slice(0, MAX_LINES));
          setTruncated(true);
        } else {
          setLines(allLines);
        }
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [filePath]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden font-mono text-[11px] leading-5">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-2 py-1">
        {paneId && (
          <Tooltip label="Back to files">
            <button
              onClick={() => showFilesInPane(paneId)}
              aria-label="Back to files"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/50 hover:bg-white/10 hover:text-white"
            >
              <ArrowLeft size={12} weight="bold" />
            </button>
          </Tooltip>
        )}
        <span className="truncate text-[10px] text-white/35">
          {filePath ? relativePath(filePath) : "no file"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!filePath && (
          <div className="px-3 py-2 text-[11px] text-white/35">
            Open a file from the Files pane.
          </div>
        )}
        {error && (
          <div className="px-3 py-2 text-[11px] text-rose-300/70">
            {error}
          </div>
        )}
        {filePath && lines === null && !error && (
          <div className="px-3 py-2 text-[11px] italic text-white/30">
            loading…
          </div>
        )}
        {lines && (
          <table className="min-w-full border-collapse">
            <colgroup>
              <col style={{ width: "2.75rem" }} />
              <col />
            </colgroup>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="group hover:bg-white/4">
                  <td className="select-none whitespace-nowrap px-3 text-right text-[10px] text-white/20 group-hover:text-white/35">
                    {i + 1}
                  </td>
                  <td className="whitespace-pre px-2">{highlight(line)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {truncated && (
          <div className="border-t border-white/8 px-3 py-2 text-[10px] italic text-white/35">
            File truncated at {MAX_LINES.toLocaleString()} lines.
          </div>
        )}
      </div>
    </div>
  );
}
