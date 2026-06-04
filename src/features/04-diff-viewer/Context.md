# diff-viewer

## Status
Not yet implemented. Folder scaffolded as a placeholder.

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
  addition to the live working-tree diff?
