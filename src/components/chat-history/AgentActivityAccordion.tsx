import { useState } from "react";
import {
  Gear,
  CaretDown,
  NotePencil,
  Eye,
  TerminalWindow,
  MagnifyingGlass,
  FileText,
  type Icon,
} from "@phosphor-icons/react";
import type { Message, ToolKind } from "../../stores/use-messages-store";
import { MessageItem } from "./MessageItem";
import { Collapse } from "../Collapse";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import {
  activeSummary,
  baseName,
  clampWords,
  DiffStat,
  rollupFiles,
  verbForKind,
} from "./tool-summary";

const FILE_KIND_ICONS: Record<ToolKind, Icon> = {
  write: NotePencil,
  read: Eye,
  run: TerminalWindow,
  search: MagnifyingGlass,
};

const FILE_KIND_TEXT: Record<ToolKind, string> = {
  read: "text-sky-200",
  write: "text-amber-200",
  run: "text-emerald-200",
  search: "text-fuchsia-200",
};

interface AgentActivityAccordionProps {
  messages: Message[];
}

/**
 * Collapses a run of consecutive tool messages (list_projects, write_file, etc.)
 * into a single toggle row — mirrors the Reasoning accordion but for agent tool calls.
 *
 * Header states:
 *   working  → spinning gear + pulsing dots + "Agent is working"
 *   done     → static gear + "Agent worked · N actions"
 *
 * Collapsed by default so the chat stays readable while the agent runs.
 */
export function AgentActivityAccordion({ messages }: AgentActivityAccordionProps) {
  const [open, setOpen] = useState(false);
  const openDiffForFile = useWorkspaceStore((s) => s.openDiffForFile);

  // If any tool in this run is still in progress, the whole accordion is "working".
  const isWorking = messages.some((m) => m.toolStatus === "running");
  const count = messages.length;

  // While working, surface the *active summary* of the tool currently running
  // (latest one) right in the header — so the user reads what's happening at a
  // glance without expanding. Capped at 25 words by `activeSummary`.
  const runningMsg = [...messages]
    .reverse()
    .find((m) => m.toolStatus === "running");
  const workingLabel = runningMsg
    ? clampWords(activeSummary(runningMsg))
    : "Agent is working";

  // Net diff roll-up across the whole run, shown when the agent has finished —
  // the accessible "+x | −x" surfaces the total change without expanding.
  const totalAdded = messages.reduce((s, m) => s + (m.linesAdded ?? 0), 0);
  const totalRemoved = messages.reduce((s, m) => s + (m.linesRemoved ?? 0), 0);
  const hasDiffTotals = totalAdded > 0 || totalRemoved > 0;

  // Per-file roll-up for the "Files touched" panel + the collapsed file count.
  // Only tool rows that carry a real `toolPath` contribute — generic ops with
  // no file (list_projects, shell one-liners) are intentionally absent here so
  // the panel stays focused on actual filesystem activity.
  const files = rollupFiles(messages);
  const fileCount = files.length;

  return (
    <div className="flex flex-col">
      {/* ── toggle button — same style as the Reasoning toggle ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-ink/40 hover:bg-ink/5 hover:text-ink/60"
      >
        <Gear
          size={12}
          className={isWorking ? "animate-spin" : ""}
        />

        <span className="max-w-[18rem] truncate">
          {isWorking ? workingLabel : "Agent worked"}
        </span>

        {isWorking ? (
          /* pulsing dots — same cadence as ThinkingBubble */
          <span className="ml-0.5 inline-flex gap-0.5">
            <span className="h-1 w-1 animate-pulse rounded-full bg-ink/40 [animation-delay:0ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-ink/40 [animation-delay:150ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-ink/40 [animation-delay:300ms]" />
          </span>
        ) : (
          <>
            <span className="tabular-nums text-ink/30">
              · {count} {count === 1 ? "action" : "actions"}
            </span>
            {fileCount > 0 && (
              <span className="inline-flex items-center gap-1 text-ink/45">
                <span className="text-ink/25">·</span>
                <FileText size={10} weight="regular" className="text-ink/40" />
                <span className="tabular-nums">
                  {fileCount} {fileCount === 1 ? "file" : "files"}
                </span>
              </span>
            )}
            {hasDiffTotals && (
              <DiffStat added={totalAdded} removed={totalRemoved} compact />
            )}
          </>
        )}

        <CaretDown
          size={10}
          className={["ml-auto transition-transform", open ? "rotate-180" : ""].join(" ")}
        />
      </button>

      {/* ── expanded body — frosted card, same as Reasoning ── */}
      <Collapse open={open}>
        <div
          className={[
            "mt-1 flex flex-col gap-2 rounded-xl px-3 py-2.5",
            "border border-white/20 bg-white/12 backdrop-blur-xl",
            "shadow-[0_4px_20px_rgba(255,255,255,0.04),inset_0_1px_0_rgba(255,255,255,0.15)]",
          ].join(" ")}
        >
          {/* Files-touched roll-up — answers "which files did the agent
              actually open/modify?" without forcing the user to scan every
              tool row. Hidden when no row carried a path (e.g. a turn made
              entirely of list_projects / shell pings). */}
          {fileCount > 0 && (
            <div className="flex flex-col gap-1 rounded-lg border border-white/10 bg-ink/5 px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink/45">
                <FileText size={10} weight="regular" />
                <span>
                  Files touched · {fileCount}
                </span>
              </div>
              <ul className="flex flex-col gap-0.5">
                {files.map((f) => {
                  const primary = f.kinds[0];
                  const Icon = FILE_KIND_ICONS[primary];
                  const accent = FILE_KIND_TEXT[primary];
                  const base = baseName(f.path) ?? f.path;
                  const hasDiff = f.linesAdded > 0 || f.linesRemoved > 0;
                  const verbs = f.kinds.map(verbForKind).join(" · ");
                  return (
                    <li key={f.path}>
                      <button
                        type="button"
                        onClick={() => openDiffForFile(f.path)}
                        className="-mx-1 flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] hover:bg-ink/5 focus:bg-ink/5 focus:outline-none"
                        title={f.path}
                        aria-label={`Open diff for ${f.path}`}
                      >
                        <Icon size={11} className={accent} />
                        <span className={["font-mono font-medium", accent].join(" ")}>
                          {base}
                        </span>
                        <span className="truncate font-mono text-ink/35">
                          {f.path !== base ? f.path : ""}
                        </span>
                        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-ink/50">
                          <span>{verbs}</span>
                          {f.count > 1 && (
                            <span className="tabular-nums text-ink/35">
                              ×{f.count}
                            </span>
                          )}
                          {hasDiff && (
                            <DiffStat
                              added={f.linesAdded}
                              removed={f.linesRemoved}
                              compact
                            />
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Per-action trace — every tool call in this run, in the order the
              agent produced it. The Files-touched panel above is the summary;
              this is the full timeline. */}
          <div className="flex flex-col gap-1.5">
            {messages.map((m) => (
              <MessageItem key={m.id} message={m} />
            ))}
          </div>
        </div>
      </Collapse>
    </div>
  );
}
