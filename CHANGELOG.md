# Changelog

All notable changes to AKA are documented here. Versions follow the app
version stamped in `src-tauri/tauri.conf.json`.

## 1.2.1

### Added
- **Windows and Linux installers.** 1.2.0 shipped macOS-only — the release build
  couldn't bundle the new `aka-tool` shim for non-macOS targets. CI now builds
  the shim per target triple, so the Windows (`.exe` / `.msi`) and Linux
  (`.AppImage` / `.deb` / `.rpm`) installers are published again. No app changes
  from 1.2.0.

## 1.2.0

### Added
- **Overridable built-in tools (the "pantry").** AKA now ships a small set of
  built-in tools the agent can call through the bundled `aka-tool` CLI, placed
  on the agent's PATH on every run. First tool: **`diagnostics`** — runs the
  project's configured typecheck/lint (`agent.diagnostics_cmd`) and returns
  structured `{file, line, severity, message}`. Fully agnostic and overridable:
  the agent's own same-named tools always win, and AKA only fills the gaps.
- **Per-agent capability declaration.** The agent editor gains a "Tools it
  already provides" field; AKA honors those first and, in gap-fill mode, drops
  them from what it advertises.
- **Advertise vs gap-fill control** per project (`tools.mode` / `tools.enabled`),
  with the manifest exported to agents via the `AKA_TOOLS` env var and a
  generated `.äkä/TOOLS.md`.
- **Tools indicator** in the chat bar showing how many built-in tools are
  advertised and how many the active agent overrides.
- **Smarter local-runtime detection.** AKA now detects which runtimes are
  *installed* — not just running — by looking for each one's CLI binary or macOS
  app bundle, searching beyond the process PATH (Homebrew, `~/.local/bin`, and
  pip-user locations) so a Finder-launched app still finds them. Adds MLX
  (`:8081`) and Jan (`:1337`) alongside Ollama, LM Studio, and llama.cpp, and the
  connection and first-run panels now show only runtimes you actually have
  (running, or installed but stopped), with "Connected / Installed but not
  running" hints.

### Fixed
- **ANSI stripping no longer corrupts prose.** The escape-sequence regex now
  requires an ESC prefix, so a bare `[0m`-style fragment inside legitimate text
  (e.g. `arr[0m]`) is left intact instead of being deleted from the model's
  reply. Fixed in both the agent-output noise parser and the SmallCode parser.

### Removed
- Unused legacy custom-agent modal (the inline agent panel is the only editor).

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
