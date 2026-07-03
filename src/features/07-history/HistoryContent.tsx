import { useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  GitCommit,
  GitDiff,
} from "@phosphor-icons/react";
import { useProjectsStore } from "../../stores/use-projects-store";
import {
  useActiveSessionCheckpoints,
  useActiveSessionCheckpointsAvailable,
  useChatStore,
} from "../../stores/use-chat-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { Tooltip } from "../../components/Tooltip";
import type { Checkpoint } from "../../lib/tauri/commands";
import { groupRunSpans, type RunSpan } from "./group-runs";

/** Short relative age, e.g. "8s ago", "3m ago", "2h ago". */
function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** Dot colour by checkpoint kind — baseline/result stand out from steps. */
function dotClass(kind: string): string {
  switch (kind) {
    case "prerun":
      return "bg-sky-400";
    case "postrun":
      return "bg-emerald-400";
    case "prerestore":
      return "bg-amber-400";
    default:
      return "bg-white/40"; // step / manual
  }
}

/**
 * Task History pane — a browsable list of this session's past agent runs,
 * reconstructed from the git checkpoint stream (`checkpointsBySession`,
 * grouped on "prerun" boundaries by [[group-runs]]). Each run expands to its
 * checkpoints; any checkpoint can be restored (the backend snapshots first,
 * so a restore is itself undoable), and "View diff" opens the Diff pane
 * (working tree vs HEAD) to review the cumulative result.
 *
 * Scope: in-session only. Chat/run state is not persisted to disk, so runs
 * from before an app restart aren't listed — only their git checkpoint refs
 * survive, without task context. See Context.md.
 */
export function HistoryContent() {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  const checkpoints = useActiveSessionCheckpoints();
  const available = useActiveSessionCheckpointsAvailable();
  const lastTask = useChatStore((s) =>
    activeSessionId ? (s.lastTaskBySession[activeSessionId] ?? null) : null,
  );
  const rollbackTo = useChatStore((s) => s.rollbackTo);
  const openPane = useWorkspaceStore((s) => s.openPane);

  const spans = useMemo(() => groupRunSpans(checkpoints), [checkpoints]);
  // Newest first — the run you just finished is the one you're reviewing.
  const rows = useMemo(() => [...spans].reverse(), [spans]);

  if (!activeSessionId) {
    return (
      <Empty
        title="No active session"
        hint="Pick a project session from the bottom rail to see its run history."
      />
    );
  }
  if (!available) {
    return (
      <Empty
        title="History unavailable"
        hint="This project isn't a git repository, so runs aren't checkpointed."
      />
    );
  }
  if (rows.length === 0) {
    return (
      <Empty
        title="No runs yet"
        hint="Launch an agent task — each run is checkpointed and will appear here."
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/8 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[10px] text-white/45">
          <ClockCounterClockwise size={11} className="shrink-0 text-white/35" />
          {spans.length} run{spans.length === 1 ? "" : "s"} this session
        </span>
        <Tooltip label="Open the Diff pane — working tree vs HEAD" side="bottom">
          <button
            onClick={() => openPane("diff")}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-white/60 hover:bg-white/10 hover:text-white/90"
          >
            <GitDiff size={11} />
            View diff
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-1.5">
          {rows.map((span) => (
            <RunRow
              key={`${span.index}-${span.startedAt}`}
              span={span}
              // Task text is only tracked for the session's latest run.
              task={span.index === spans.length ? lastTask : null}
              onRestore={(sha) => void rollbackTo(activeSessionId, sha)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <div className="text-sm text-white/40">{title}</div>
      <div className="text-[11px] text-white/25">{hint}</div>
    </div>
  );
}

function RunRow({
  span,
  task,
  onRestore,
}: {
  span: RunSpan;
  task: string | null;
  onRestore: (sha: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const finished = !!span.postrun;
  const filesChanged = span.postrun?.filesChanged ?? 0;
  // A span with no prerun is pre-run housekeeping (manual/prerestore snaps).
  const title = span.prerun ? `Run ${span.index}` : "Snapshots";

  return (
    <li className="rounded-xl border border-white/10 bg-white/[0.04]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <span
          className={[
            "h-2 w-2 shrink-0 rounded-full",
            span.prerun ? (finished ? "bg-emerald-400" : "bg-sky-400 animate-pulse") : "bg-white/40",
          ].join(" ")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[12px] font-semibold text-white/85">{title}</span>
            <span className="text-[10px] text-white/40">{relTime(span.startedAt)}</span>
          </div>
          <div className="truncate text-[11px] text-white/50">
            {task ??
              (span.prerun
                ? finished
                  ? `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`
                  : "In progress…"
                : "Manual / pre-restore snapshots")}
          </div>
        </div>
        <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/55">
          {span.checkpoints.length}
        </span>
        <span className="text-white/40">
          {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </span>
      </button>

      {expanded && (
        <ul className="border-t border-white/8 px-1.5 py-1.5">
          {[...span.checkpoints].reverse().map((cp) => (
            <CheckpointRow key={`${cp.seq}-${cp.sha}`} cp={cp} onRestore={onRestore} />
          ))}
        </ul>
      )}
    </li>
  );
}

function CheckpointRow({
  cp,
  onRestore,
}: {
  cp: Checkpoint;
  onRestore: (sha: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass(cp.kind)}`} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-white/85">{cp.label}</div>
        <div className="flex items-center gap-1 text-[10px] text-white/40">
          <GitCommit size={10} />
          {cp.sha.slice(0, 7)} · {relTime(cp.createdAt)}
          {cp.filesChanged > 0
            ? ` · ${cp.filesChanged} file${cp.filesChanged === 1 ? "" : "s"}`
            : ""}
        </div>
      </div>

      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => {
              onRestore(cp.sha);
              setConfirming(false);
            }}
            className="rounded-full bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-amber-950 transition-colors hover:bg-amber-300"
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="rounded-full px-2 py-1 text-[11px] text-white/55 hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      ) : (
        <Tooltip label="Roll the working tree back to this snapshot (undoable)">
          <button
            onClick={() => setConfirming(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/10"
          >
            <ArrowCounterClockwise size={12} />
            Restore
          </button>
        </Tooltip>
      )}
    </li>
  );
}
