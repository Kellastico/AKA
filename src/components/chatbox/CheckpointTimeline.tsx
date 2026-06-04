import { useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CameraPlus,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  GitCommit,
} from "@phosphor-icons/react";
import { useProjectsStore } from "../../stores/use-projects-store";
import {
  useActiveSessionCheckpoints,
  useActiveSessionCheckpointsAvailable,
  useChatStore,
} from "../../stores/use-chat-store";
import { Tooltip } from "../Tooltip";
import type { Checkpoint } from "../../lib/tauri/commands";

/**
 * Feature flag — Checkpoints UI is hidden for the current MVP scope. The
 * backend still snapshots before/after each run (see agent_runner.rs), so no
 * data is lost; only the timeline UI is suppressed. Flip to `true` to restore
 * the feature with zero other changes.
 */
const CHECKPOINTS_ENABLED = false;

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
 * Checkpoint timeline for the active session — AKA's agent-agnostic "undo".
 * Rendered just above the composer (like the approval card). Each snapshot can
 * be restored, which rolls the working tree back to that point; the backend
 * auto-snapshots first, so a rollback is itself undoable.
 *
 * Hidden entirely when there's nothing to show. When the project isn't a git
 * repo (so checkpoints are unavailable) but a run happened, a muted hint
 * explains why there's nothing to roll back to.
 */
// Wrapper gates the feature without breaking the Rules of Hooks — it calls no
// hooks itself, so returning early is safe. The real implementation (with all
// its hooks) only mounts when the feature is on.
export function CheckpointTimeline() {
  if (!CHECKPOINTS_ENABLED) return null;
  return <CheckpointTimelineImpl />;
}

function CheckpointTimelineImpl() {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  const checkpoints = useActiveSessionCheckpoints();
  const available = useActiveSessionCheckpointsAvailable();
  const rollbackTo = useChatStore((s) => s.rollbackTo);
  const manualCheckpoint = useChatStore((s) => s.manualCheckpoint);
  const restart = useChatStore((s) => s.restart);
  const hasLastTask = useChatStore((s) =>
    activeSessionId ? !!s.lastTaskBySession[activeSessionId] : false,
  );

  const [expanded, setExpanded] = useState(false);
  const [confirmSha, setConfirmSha] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!activeSessionId) return null;

  // Not a git repo: only worth a note once a run has happened in this session.
  if (!available) {
    if (!hasLastTask) return null;
    return (
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] text-white/45">
        <GitCommit size={13} />
        Checkpoints unavailable — this project isn't a git repository.
      </div>
    );
  }

  if (checkpoints.length === 0) return null;

  const doRestore = async (cp: Checkpoint) => {
    setBusy(true);
    try {
      await rollbackTo(activeSessionId, cp.sha);
    } finally {
      setBusy(false);
      setConfirmSha(null);
    }
  };

  // Newest first in the list — most recent snapshot is the likeliest target.
  const rows = [...checkpoints].reverse();

  return (
    <div className="mb-2 rounded-2xl border border-white/15 bg-white/[0.07] backdrop-blur-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ClockCounterClockwise size={15} className="shrink-0 text-white/60" />
          <span className="text-[12px] font-semibold text-white/85">Checkpoints</span>
          <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/55">
            {checkpoints.length}
          </span>
          <span className="ml-auto text-white/40">
            {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </span>
        </button>

        <Tooltip label="Snapshot the working tree now">
          <button
            onClick={() => void manualCheckpoint(activeSessionId)}
            aria-label="Checkpoint now"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-white/60 transition-colors hover:bg-white/10 hover:text-white/90"
          >
            <CameraPlus size={14} />
          </button>
        </Tooltip>
        {hasLastTask && (
          <Tooltip label="Roll back to before the run, then re-run the task">
            <button
              onClick={() => restart(activeSessionId)}
              aria-label="Restart run"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-white/60 transition-colors hover:bg-white/10 hover:text-white/90"
            >
              <ArrowClockwise size={14} />
            </button>
          </Tooltip>
        )}
      </div>

      {expanded && (
        <ul className="max-h-56 overflow-y-auto px-1.5 pb-1.5">
          {rows.map((cp) => {
            const confirming = confirmSha === cp.sha;
            return (
              <li
                key={`${cp.seq}-${cp.sha}`}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${dotClass(cp.kind)}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-white/85">{cp.label}</div>
                  <div className="text-[10px] text-white/40">
                    {relTime(cp.createdAt)}
                    {cp.filesChanged > 0
                      ? ` · ${cp.filesChanged} file${cp.filesChanged === 1 ? "" : "s"}`
                      : ""}
                  </div>
                </div>

                {confirming ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void doRestore(cp)}
                      disabled={busy}
                      className="rounded-full bg-amber-400 px-2.5 py-1 text-[11px] font-semibold text-amber-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
                    >
                      {busy ? "Restoring…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => setConfirmSha(null)}
                      disabled={busy}
                      className="rounded-full px-2 py-1 text-[11px] text-white/55 hover:bg-white/10"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <Tooltip label="Roll the working tree back to this snapshot">
                    <button
                      onClick={() => setConfirmSha(cp.sha)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/10"
                    >
                      <ArrowCounterClockwise size={12} />
                      Restore
                    </button>
                  </Tooltip>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
