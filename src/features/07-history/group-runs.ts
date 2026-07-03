import type { Checkpoint } from "../../lib/tauri/commands";

/**
 * One agent run reconstructed from a session's checkpoint stream. A session
 * (runId == sessionId) accumulates checkpoints across every run it launches:
 * "prerun" marks a run baseline, "step"/"manual" land in between, "postrun"
 * closes a run. Grouping on "prerun" boundaries recovers the per-run history.
 */
export type RunSpan = {
  /** 1-based chronological run number within the session. */
  index: number;
  /** All checkpoints in this span, oldest first. */
  checkpoints: Checkpoint[];
  /** The "Before run" baseline, when this span has one. */
  prerun?: Checkpoint;
  /** The "After run" snapshot — present once the run finished. */
  postrun?: Checkpoint;
  startedAt: number;
};

/**
 * Split a session's checkpoints (oldest first, as stored in
 * `checkpointsBySession`) into run spans. Every "prerun" starts a new span;
 * anything recorded before the first prerun (a manual snapshot, a prerestore)
 * forms a leading span of its own so no checkpoint is dropped.
 */
export function groupRunSpans(checkpoints: Checkpoint[]): RunSpan[] {
  const spans: RunSpan[] = [];
  let current: Checkpoint[] = [];

  const flush = () => {
    if (current.length === 0) return;
    spans.push({
      index: spans.length + 1,
      checkpoints: current,
      prerun: current.find((c) => c.kind === "prerun"),
      postrun: current.find((c) => c.kind === "postrun"),
      startedAt: current[0].createdAt,
    });
    current = [];
  };

  for (const cp of checkpoints) {
    if (cp.kind === "prerun") flush();
    current.push(cp);
  }
  flush();

  return spans;
}
