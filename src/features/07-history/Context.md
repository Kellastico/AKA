# history

## Status
**Real and shipped (in-session scope).** Implemented by
[`HistoryContent.tsx`](./HistoryContent.tsx), rendered as the "History" pane
(`pane.type === "history"` — open it from the "+ Open Preview" picker).

What it does:
- Reconstructs the active session's past agent runs from the git checkpoint
  stream: `checkpointsBySession` in `use-chat-store` (populated live by the
  `checkpoint://created` listener), grouped into run spans on `"prerun"`
  boundaries by [`group-runs.ts`](./group-runs.ts) (unit-tested in
  `__tests__/group-runs.test.ts`).
- Each run row shows status (finished / in progress), age, files changed
  (from the postrun checkpoint), and — for the session's latest run — the
  task text (`lastTaskBySession`). Expanding a run lists its checkpoints
  (kind-colored dots, short sha, age).
- Any checkpoint can be **restored** via the existing `rollbackTo` plumbing
  (`restore_checkpoint`; the backend snapshots first, so restores are
  undoable).
- **View diff** opens the Diff pane (feature 04) — the existing `git_diff`
  working-tree-vs-HEAD review.

Built fresh rather than re-enabling `CheckpointTimeline.tsx`
(`src/components/chatbox/`, still gated off by `CHECKPOINTS_ENABLED = false`
and deliberately untouched): that component is a composer-adjacent widget for
the *live* run's flat checkpoint list, while this is a cross-run browser.
The two share idioms (relTime, kind dots, confirm-then-restore) but not code.

## Decisions
- **In-session only, by design.** Chat messages and run metadata are not
  persisted to disk — only the git checkpoint refs
  (`refs/aka/checkpoints/<runId>/<seq>`) survive an app restart, and those
  carry no task context. So history honestly covers the current app
  session; it does not fabricate a cross-restart archive.

## Open questions
- Persist a lightweight run index (runId → task text → checkpoint seqs) via
  tauri-plugin-store so history survives restarts? Deferred — decided
  against for the initial build to avoid new storage.
- Per-run diff (prerun vs postrun sha) needs `git_diff` to accept sha
  arguments; today it only diffs working tree vs HEAD. `run_file_changes`
  already computes per-file numstat between those shas if a richer view is
  wanted later.
