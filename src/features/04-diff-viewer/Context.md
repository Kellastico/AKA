# diff-viewer

## Status
**Real and shipped.** Implemented by [`DiffContent.tsx`](./DiffContent.tsx)
(moved here from `src/components/pane-content/` — `Pane.tsx` renders it for
`pane.type === "diff"`).

Contrary to the original plan (and an old README claim), this is **not
Monaco**. It is a hand-rolled unified-diff renderer:

- Calls the live `gitDiff` Tauri command (`git_diff` in
  `src-tauri/src/commands/diff.rs`, which runs
  `git diff --no-color HEAD [-- file]` in the project).
- Parses hunk (`@@`) and file (`diff --git`) headers into a flat row list.
- Renders colored add/remove rows with old/new line numbers, per-file
  section headers, live +/− counts in the header, and a refresh button.
- Supports an optional `filePath` prop for single-file diffs
  (`openDiffForFile` in `use-workspace-store`).

`monaco-editor` was never a dependency and is not planned — the custom
renderer is small, fast, and sufficient for review-and-approve.

## Decisions
- **Diff review pairs with checkpoint rollback.** `git_diff` (`commands::diff`)
  shows the cumulative working-tree change since HEAD; the "undo" half of the
  review lives in git checkpoints (`commands::checkpoints`, surfaced by
  `CheckpointTimeline.tsx`). The intended flow: run an agent → review the diff →
  **Keep** (do nothing) or **Roll back** to a checkpoint (e.g. "Before run").
  This is AKA's agent-agnostic substitute for a proactive per-action approval
  gate — it works even for non-interactive agents.

## Open questions
- Should the diff pane render a per-checkpoint diff (snapshot vs HEAD) in
  addition to the live working-tree diff? (The `git_diff` command currently
  only diffs working tree vs HEAD — no sha arguments.)
