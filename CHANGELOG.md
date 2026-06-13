# Changelog

All notable changes to AKA are documented here. Versions follow the app
version stamped in `src-tauri/tauri.conf.json`.

## 1.0.3

### Fixed
- **Reasoning leaking into the chat body.** Thinking models whose chat
  template prefills the `<think>` opener (Mellum 2-Thinking, DeepSeek-R1, and
  similar) stream only a closing `</think>`, which the parser never matched —
  so reasoning, and a stray `</think>`, spilled into the message body. The
  stream parser now handles orphan close tags, tags split across chunks, and
  reads native reasoning fields (`reasoning` / `reasoning_content`) when the
  runtime separates thinking for us.
- **Lingering chat when importing a project.** Importing a new project (even
  one with a name similar to an existing project) showed the previously
  open project's chat. Every imported project now starts in its own fresh
  session, activated atomically so the chat view never inherits stale history.

### Added
- **Live reasoning containment for thinking models.** AKA now learns which
  models prefill their thinking block and, on every later run, routes their
  reasoning straight to the Reasoning accordion as it streams — including in
  agent mode, where each tool call cuts a model off mid-thought. Safety valves
  move text back to the body if a model ends without reasoning, so an answer is
  never stranded in the accordion. Fully model-agnostic — nothing is
  hardcoded; the behavior is detected and remembered per model.
- **Hard reload for the Preview pane.** ⇧-click the Preview reload button to
  wipe the webview's HTTP cache before refetching. Normal reloads now also
  cache-bust the iframe URL, so dev servers that don't send no-cache headers
  (python `http.server`, `serve`, …) can no longer leave the preview stale.

### Changed
- **File watcher now detects deletions and static builds.** The project
  watcher tracks file count alongside modification time, so removing a file
  rolls the preview forward (a max-mtime-only check was blind to deletions).
  The `dist` directory is now watched so static-build output updates the
  preview instead of leaving it stale.
- Refreshed preview screenshots.

## 1.0.2

### Added
- Delete a project from the bottom bar.

## 1.0.1

### Added
- Image passthrough to agents — attached images are exposed to the agent via
  `AKA_IMAGE_PATHS` / `AKA_ATTACHMENTS`.

### Fixed
- Agent image path resolution.
