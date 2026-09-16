# file-explorer

## Status
**Real and shipped.** Implemented by [`FilesContent.tsx`](./FilesContent.tsx)
(moved here from `src/components/pane-content/` — `Pane.tsx` renders it for
`pane.type === "files"`). Labelled **Filetree** in the UI; the pane *type* is
still `files` (renaming the type would only churn the store).

It is backed by **real filesystem calls, not mock data**: `listDir` /
`countLines` / `walkProject` in `src/lib/tauri/commands.ts` → `list_dir` /
`count_lines` / `walk_project` in `src-tauri/src/commands/files.rs` →
`tokio::fs` directly. (`src/lib/mock-file-tree.ts` exists but is dead code —
only `FileFinder.tsx` references it, and nothing opens `FileFinder`.)

What it does:
- Lazy tree: directories load their children on first expand, cached per path.
- Per-entry line counts (`countLines`), formatted (`1.2k`).
- Live refresh: `useProjectWatch` re-reads the root and every expanded subdir
  when anything under the project changes on disk (agent edits included),
  and drops line counts so visible rows recount.
- **Two columns**: tree on the left, the open file on the right (see below).
- **In-pane search** (see below).
- **Expand to full width** via the pane header control (see
  `Workspace.tsx` / `use-workspace-store.ts`).

## Search
The top bar's centred search box (`Omnibox.tsx`, deleted) moved in here, and
the top bar carries no search affordance at all any more — this pane owns file
search outright. You reach it by opening the pane from the "+" menu.

Two render modes, switched on whether the query is empty:
- **Empty query** → the lazy tree, unchanged. Costs nothing extra.
- **Non-empty** → a pruned tree built from a flat `walkProject` index by
  [`filter-tree.ts`](./filter-tree.ts): every match plus the ancestor folders
  needed to place it, fully expanded, ancestors dimmed.

Behaviour worth knowing:
- Matching is a case-insensitive substring over the **relative path**, so both
  `store` and `stores/use-work` narrow usefully.
- ↑/↓ walk the file hits in render order; Enter opens the active one. With no
  hits, Enter tries the raw text as a path (absolute, or relative to the root)
  so a pasted path still works — that was the old Omnibox's core job.
- Clicking a folder row in search mode narrows the query to that folder rather
  than toggling it; there is nothing to toggle in an already-expanded view.
- The "Add Context.md" (`md`) button keeps the Omnibox's targeting rule: the
  folder the query names, falling back to the project root. Target is in the
  tooltip.

The index is fetched lazily on first keystroke, not on mount — an unused search
box shouldn't cost a tree walk. `useProjectWatch` only *flags* it stale rather
than re-walking, so a project rebuild can't thrash it; the next keystroke pays.

## Split view
The pane is a two-column browser: [`FileTreePanel`](./FilesContent.tsx) on the
left, the open file on the right (`FileContent`, or `MarkdownPane` for
`.md`/`.mdx`/`.markdown`). With nothing open the right column carries an empty
state — "Open files appear here".

Which file is open lives on the pane itself (`ExtraPane.filePath`), not in this
feature's state, so it survives a remount and is what `openFileInFiletree`
writes to.

- **`splitLayout(width, hasFile)`** in [`split-layout.ts`](./split-layout.ts)
  decides what is on screen. At ≥ `SPLIT_MIN_WIDTH` (560px) both columns show.
  Below it the pane falls back to one column: the tree until you pick a file,
  then the file with a back control. Pane width comes from a `ResizeObserver`
  measured in a layout effect, so the first paint already knows its layout.
- **Both columns stay mounted at every width.** The one that isn't showing is
  `display: none`, not unmounted — collapsing the window must not throw away
  expanded folders, the search index, or an unsaved Markdown edit.
- The divider ([`FiletreeSplitter.tsx`](./FiletreeSplitter.tsx)) drags on
  pointer capture like the workspace `Resizer`, and is keyboard-operable
  (←/→). Its ratio lives in `use-filetree-store` so it is remembered for the
  session.

## The filetree owns file viewing
There is no standalone `file` pane type any more. Every route to *view* a file
ends in this pane's right column via `openFileInFiletree`:
- clicking a row in the tree;
- clicking a path chip in the conversation that has **no diff** behind it
  (`RunTimeline` / `MessageItem`) — a path the agent merely read. Chips that do
  have a diff still open the Diff pane, unchanged.

`FileContent` and `MarkdownPane` no longer reach into the workspace store for a
"back to files" action; they take an optional `onBack` callback, which the
filetree supplies only in narrow mode.

## Decisions
- Read-only browsing — file *editing* stays the agent's job (markdown panes
  are the one exception, see root CLAUDE.md).
- Search filters **in place** rather than opening a dropdown. The pane is
  already a tree; a floating result list over it would be a second thing to
  read.
- `walk_project` is bounded (depth 12, 20k entries) and honours the same
  `is_noise` filter as `list_dir`, so search can never surface a row the
  unfiltered tree would hide. When a bound is hit the pane says so rather than
  reporting a confident "no match".
- Picking a file no longer flips the pane's *type*, so an expanded filetree
  stays expanded while you read — which is the point of expanding it.

## Open questions
- `FileFinder.tsx` (⌘P-style overlay over `MOCK_PATHS`) is unreachable — nothing
  calls `openFinder`. Now that search lives here, it is probably deletable.
