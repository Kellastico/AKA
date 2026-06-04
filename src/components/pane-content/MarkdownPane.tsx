import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CircleNotch,
  FloppyDisk,
  Warning,
  ArrowsClockwise,
  Eye,
  X,
} from "@phosphor-icons/react";
import { useFileBuffer } from "../../lib/use-file-buffer";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { Tooltip } from "../Tooltip";

/**
 * Editable Markdown pane.
 *
 * Per project doctrine, code files stay read-only and route through the
 * agent-diff approval flow. Markdown is the explicit exception: users may
 * type directly into a .md pane, and the agent may also rewrite the same
 * file on disk. When both happen, the conflict banner surfaces.
 */
export function MarkdownPane({
  paneId,
  filePath,
}: {
  paneId?: string;
  filePath?: string;
}) {
  const buf = useFileBuffer(filePath ?? null);
  const [diffOpen, setDiffOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const showFilesInPane = useWorkspaceStore((s) => s.showFilesInPane);

  // Cmd/Ctrl+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (document.activeElement === textareaRef.current) {
          e.preventDefault();
          void buf.save();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [buf]);

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-white/30">
        No file selected.
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* path + status bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-2 py-1.5">
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
        <span className="truncate text-[10px] text-white/35">{filePath}</span>
        <span className="ml-auto inline-flex items-center gap-2 text-[10px] text-white/40">
          {buf.status === "loading" && (
            <span className="inline-flex items-center gap-1">
              <CircleNotch size={11} className="animate-spin" />
              loading
            </span>
          )}
          {buf.status === "saving" && (
            <span className="inline-flex items-center gap-1">
              <CircleNotch size={11} className="animate-spin" />
              saving
            </span>
          )}
          {buf.dirty && buf.status === "ready" && (
            <span className="text-amber-300/80">unsaved</span>
          )}
          <button
            type="button"
            onClick={() => void buf.save()}
            disabled={!buf.dirty || buf.status !== "ready"}
            className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-white/70 hover:bg-white/10 disabled:opacity-30"
            title="Save (⌘S)"
          >
            <FloppyDisk size={11} weight="bold" />
            Save
          </button>
        </span>
      </div>

      {/* conflict banner */}
      {buf.conflict && (
        <div className="shrink-0 border-b border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <div className="flex items-start gap-2">
            <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-300" />
            <div className="flex-1">
              <div className="font-medium">
                The agent rewrote this file while you had unsaved edits.
              </div>
              <div className="mt-0.5 text-[11px] text-amber-100/70">
                Choose which version to keep. Reloading discards your edits.
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                onClick={buf.reloadFromDisk}
                className="inline-flex items-center gap-1 rounded border border-amber-300/40 bg-amber-400/15 px-2 py-0.5 text-[11px] text-amber-100 hover:bg-amber-400/25"
              >
                <ArrowsClockwise size={11} weight="bold" />
                Reload from disk
              </button>
              <button
                onClick={() => setDiffOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10"
              >
                <Eye size={11} weight="bold" />
                {diffOpen ? "Hide diff" : "View diff"}
              </button>
              <button
                onClick={buf.dismissConflict}
                className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10"
                title="Keep my edits"
              >
                <X size={11} weight="bold" />
                Keep mine
              </button>
            </div>
          </div>

          {diffOpen && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded border border-white/10 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-white/80">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
                  Your buffer
                </div>
                <pre className="whitespace-pre-wrap break-words">{buf.value}</pre>
              </div>
              <div className="rounded border border-white/10 bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-white/80">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
                  On disk (agent)
                </div>
                <pre className="whitespace-pre-wrap break-words">
                  {buf.conflict.contents}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* error */}
      {buf.error && !buf.conflict && (
        <div className="shrink-0 border-b border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-200">
          {buf.error}
        </div>
      )}

      {/* editor */}
      <textarea
        ref={textareaRef}
        value={buf.value}
        onChange={(e) => buf.setValue(e.target.value)}
        spellCheck={false}
        placeholder={buf.status === "loading" ? "" : "# Markdown…"}
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12px] leading-6 text-white/85 placeholder:text-white/25 focus:outline-none"
      />
    </div>
  );
}
