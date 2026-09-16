import { ArrowsInSimple, ArrowsOutSimple, X } from "@phosphor-icons/react";
import {
  ExtraPane,
  PANE_LABELS,
  isExpandableType,
  useWorkspaceStore,
} from "../stores/use-workspace-store";
import { Tooltip } from "./Tooltip";
import { BrowserContent } from "./pane-content/BrowserContent";
import { ConsoleContent } from "../features/06-output-console/ConsoleContent";
import { DiffContent } from "../features/04-diff-viewer/DiffContent";
import { FilesContent } from "../features/05-file-explorer/FilesContent";
import { OutputContent } from "../features/06-output-console/OutputContent";
import { HistoryContent } from "../features/07-history/HistoryContent";

export function Pane({ pane }: { pane: ExtraPane }) {
  const closePane = useWorkspaceStore((s) => s.closePane);
  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const expandedPaneId = useWorkspaceStore((s) => s.expandedPaneId);
  const togglePaneExpanded = useWorkspaceStore((s) => s.togglePaneExpanded);

  const isActive = activePaneId === pane.id;
  const isExpanded = expandedPaneId === pane.id;
  const canExpand = isExpandableType(pane.type);
  // A filetree pane shows its open file inside its own right-hand column, so
  // only the diff pane still puts a path in the pane header.
  const isDiffWithFile = pane.type === "diff" && !!pane.filePath;
  const showsPath = isDiffWithFile;
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
        <div className="ml-2 flex shrink-0 items-center">
          {canExpand && (
            <Tooltip
              label={isExpanded ? "Collapse (Esc)" : "Expand to full width"}
              side="bottom"
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePaneExpanded(pane.id);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-white/40 hover:bg-white/8 hover:text-white/80"
                aria-label={
                  isExpanded
                    ? `Collapse ${headerLabel} pane`
                    : `Expand ${headerLabel} pane to full width`
                }
                aria-pressed={isExpanded}
              >
                {isExpanded ? (
                  <ArrowsInSimple size={14} />
                ) : (
                  <ArrowsOutSimple size={14} />
                )}
              </button>
            </Tooltip>
          )}
          <Tooltip label="Close" side="bottom">
            <button
              onClick={(e) => {
                e.stopPropagation();
                closePane(pane.id);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/40 hover:bg-white/8 hover:text-white/80"
              aria-label={`Close ${headerLabel} pane`}
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {pane.type === "diff" ? (
          <DiffContent filePath={pane.filePath} />
        ) : pane.type === "files" ? (
          <FilesContent paneId={pane.id} filePath={pane.filePath} />
        ) : pane.type === "browser" ? (
          <BrowserContent paneId={pane.id} url={pane.url} />
        ) : pane.type === "output" ? (
          <OutputContent />
        ) : pane.type === "console" ? (
          <ConsoleContent />
        ) : pane.type === "history" ? (
          <HistoryContent />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-white/25">
            {PANE_LABELS[pane.type]} content
          </div>
        )}
      </div>
    </div>
  );
}
