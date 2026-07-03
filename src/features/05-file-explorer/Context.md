# file-explorer

## Status
**Real and shipped.** Implemented by [`FilesContent.tsx`](./FilesContent.tsx)
(moved here from `src/components/pane-content/` — `Pane.tsx` renders it for
`pane.type === "files"`).

It is backed by **real filesystem calls, not mock data**: `listDir` /
`countLines` in `src/lib/tauri/commands.ts` → `list_dir` / `count_lines` in
`src-tauri/src/commands/files.rs` → `tokio::fs::read_dir` /
`tokio::fs::metadata` directly. (`src/lib/mock-file-tree.ts` exists but is
dead code — only `FileFinder.tsx` references it, unrelated to this pane.)

What it does:
- Lazy tree: directories load their children on first expand, cached per path.
- Per-entry line counts (`countLines`), formatted (`1.2k`).
- Live refresh: `useProjectWatch` re-reads the root and every expanded subdir
  when anything under the project changes on disk (agent edits included),
  and drops line counts so visible rows recount.
- Clicking a file routes it into the active pane via
  `openFileInActivePane` (`use-workspace-store`).

## Decisions
- Read-only browsing — file *editing* stays the agent's job (markdown panes
  are the one exception, see root CLAUDE.md).

## Open questions
- (none yet)
