import { X } from "@phosphor-icons/react";
import {
  ExtraPane,
  PANE_LABELS,
  useWorkspaceStore,
} from "../stores/use-workspace-store";
import { Tooltip } from "./Tooltip";
import { BrowserContent } from "./pane-content/BrowserContent";
import { ConsoleContent } from "./pane-content/ConsoleContent";
import { DiffContent } from "./pane-content/DiffContent";
import { FileContent } from "./pane-content/FileContent";
import { FilesContent } from "./pane-content/FilesContent";
import { MarkdownPane } from "./pane-content/MarkdownPane";
import { OutputContent } from "./pane-content/OutputContent";

const isMarkdownPath = (p?: string | null) =>
  !!p && /\.(md|mdx|markdown)$/i.test(p);

export function Pane({ pane }: { pane: ExtraPane }) {
  const closePane = useWorkspaceStore((s) => s.closePane);
  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);

  const isActive = activePaneId === pane.id;
  const isFile = pane.type === "file";
  const isDiffWithFile = pane.type === "diff" && !!pane.filePath;
  const showsPath = isFile || isDiffWithFile;
  const headerLabel = showsPath ? pane.filePath! : PANE_LABELS[pane.type];

  return (
    <div
      onMouseDown={() => setActivePane(pane.id)}
      className={[
        "flex h-full w-full flex-col overflow-hidden rounded-2xl border backdrop-blur-2xl transition-shadow",
        "bg-black/45",
        isActive
          ? "border-white/15 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_4px_20px_rgba(0,0,0,0.3)]"
          : "border-white/8",
      ].join(" ")}
    >
      <header className="flex items-center justify-between px-4 pt-3">
        <span
          className={[
            "min-w-0 truncate text-xs font-medium tracking-wide",
            showsPath ? "font-mono text-white/50" : "uppercase text-white/40",
          ].join(" ")}
        >
          {isDiffWithFile && (
            <span className="mr-1.5 uppercase text-white/30">Diff ·</span>
          )}
          {headerLabel}
        </span>
        <Tooltip label="Close" side="bottom">
          <button
            onClick={(e) => {
              e.stopPropagation();
              closePane(pane.id);
            }}
            className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/40 hover:bg-white/8 hover:text-white/80"
            aria-label={`Close ${headerLabel} pane`}
          >
            <X size={14} />
          </button>
        </Tooltip>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {pane.type === "diff" ? (
          <DiffContent filePath={pane.filePath} />
        ) : isFile ? (
          isMarkdownPath(pane.filePath) ? (
            <MarkdownPane paneId={pane.id} filePath={pane.filePath} />
          ) : (
            <FileContent paneId={pane.id} filePath={pane.filePath} />
          )
        ) : pane.type === "files" ? (
          <FilesContent />
        ) : pane.type === "browser" ? (
          <BrowserContent paneId={pane.id} url={pane.url} />
        ) : pane.type === "output" ? (
          <OutputContent />
        ) : pane.type === "console" ? (
          <ConsoleContent />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-white/25">
            {PANE_LABELS[pane.type]} content
          </div>
        )}
      </div>
    </div>
  );
}
