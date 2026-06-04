import { useRef, useState } from "react";
import {
  Plus,
  Terminal,
  GitDiff,
  FileText,
  TerminalWindow,
  Browser,
  type Icon,
} from "@phosphor-icons/react";
import {
  PANE_LABELS,
  PaneType,
  useWorkspaceStore,
} from "../stores/use-workspace-store";
import { Tooltip } from "./Tooltip";
import { Popover } from "./Popover";

const PANE_ICONS: Record<PaneType, Icon> = {
  output: Terminal,
  diff: GitDiff,
  files: FileText,
  console: TerminalWindow,
  file: FileText,
  browser: Browser,
};

const PICKER_TYPES: PaneType[] = ["output", "diff", "files", "console", "browser"];

export function AddPaneButton() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const extraPanes = useWorkspaceStore((s) => s.extraPanes);
  const openPane = useWorkspaceStore((s) => s.openPane);

  const atLimit = extraPanes.length >= 2;

  return (
    <>
      <Tooltip label={atLimit ? "All pane slots are filled (max 2)" : "Open a preview pane"} side="bottom">
        <button
          ref={ref}
          onClick={() => !atLimit && setOpen((v) => !v)}
          disabled={atLimit}
          className={[
            "inline-flex h-9 items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 text-xs text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl transition-colors",
            atLimit
              ? "cursor-not-allowed opacity-30"
              : "hover:bg-white/20 hover:border-white/30",
          ].join(" ")}
          aria-label="Open preview"
        >
          <Plus size={14} />
          Open Preview
        </button>
      </Tooltip>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref}>
        <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">
          Open preview
        </div>
        <div className="flex flex-col gap-1">
          {PICKER_TYPES.map((type) => {
            const Icon = PANE_ICONS[type];
            const alreadyOpen = extraPanes.some((p) => p.type === type);
            return (
              <button
                key={type}
                onClick={() => {
                  if (alreadyOpen) return;
                  openPane(type);
                  setOpen(false);
                }}
                disabled={alreadyOpen}
                className={[
                  "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition-colors",
                  alreadyOpen
                    ? "cursor-not-allowed text-white/25"
                    : "text-white/80 hover:bg-white/10",
                ].join(" ")}
              >
                <Icon size={16} className={alreadyOpen ? "opacity-40" : ""} />
                <span className="flex-1">{PANE_LABELS[type]}</span>
                {alreadyOpen && (
                  <span className="text-[10px] text-white/30">Open</span>
                )}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
