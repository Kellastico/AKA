# Changelog

All notable changes to AKA are documented here. Versions follow the app
version stamped in `src-tauri/tauri.conf.json`.

## 1.4.1

### Added
- **Saved (permanent) runtimes.** Custom endpoints (OpenRouter, remote vLLM, …)
  and the local runtimes you actually use now persist across launches in a
  **Saved runtimes** list — shown above Detected — with live health, an editable
  Base URL / API key, and a delete. Detected names (e.g. Ollama) are reconciled
  so a hydrated endpoint no longer shows as "localhost".
- **Search in the model & agent pickers.** Once a list passes ~10 entries, a
  frosted search field appears so you can filter instead of scrolling.
- **Agents can drive the dev server.** An agent can open / kill / restart the
  same dev server as the Start Dev Server button via an `@@aka` control marker.
- **Capability probe + posture hint.** A per-session `--äkä-probe` handshake
  auto-locks the model picker for agents that own their LLM connection, and the
  picker shows an advisory posture recommendation for the selected model.

### Fixed
- **Modals no longer close when you switch apps.** The runtime/model/agent
  popovers close only on an in-app outside-click — switching to a password
  manager to grab an API key no longer dismisses them mid-edit.
- **Blocked network egress is now visible.** A denied (non-allowlisted) endpoint
  surfaces a toast instead of failing silently.

### Changed
- **Clearer custom-endpoint expectations.** The Add-custom-endpoint form notes
  that AKA speaks **OpenAI-compatible** endpoints (`/chat/completions` + Bearer
  auth); for Claude/Gemini, point at a gateway like OpenRouter — a raw
  Anthropic/Google API key won't work directly.

### Under the hood
- Groundwork for the host-driven built-in agent loop: a single unified tool
  catalog projected to both surfaces (agent CLI + model), execution-enforcement
  primitives (phase gate, edit witness, approval-gated delete), and a native
  tool-calling backend. These are foundations — not yet wired into a live loop.

## 1.3.2

### Changed
- **Tool calls group under their reasoning.** In the run timeline, the tool
  calls that follow a reasoning step now read as compact chips, and a run of
  **3+ consecutive tool calls collapses into a single accordion** (e.g. "Read 3
  files", "Ran 3 commands") instead of sprawling down the rail. One or two tools
  stay inline. Expanding a group reveals the individual calls.
- **Copy on both ends of a turn.** You can now copy your own sent message (an
  icon button by its timestamp) as well as the agent's final reply — both with
  inline "Copied" feedback. Applies to agent runs and plain chat replies.

### Fixed
- **Real tool names from ReAct output.** The ReAct parser now recognises an
  `Action:` / `Observation:` keyword even when the model writes it mid-line
  (no leading newline — e.g. "…list the files.Action: list_directory"), so tool
  nodes show the real tool name instead of a generic "tool", and the scaffolding
  no longer leaks into the reasoning text. Keyword-like text inside a tool's
  observation output is left untouched.

## 1.3.1

### Changed
- **Unified run timeline.** An agent run now renders as a single ordered timeline
  where reasoning segments and tool calls interleave in the exact order they
  happened — replacing the previous two disconnected accordions (all reasoning in
  one, all tools in another). Each step is an individually collapsible node on a
  vertical rail: reasoning shows a live streaming preview and settles to a snippet,
  tools show a running state and settle to success/error with a result preview.
- **Per-segment + total timing.** Every reasoning segment and every tool call shows
  its own duration, and a run footer rolls up the total wall-clock, an approximate
  token count, and run status (e.g. `7m 6s · 3.4k tokens · done`). Live timers tick
  while a step runs and freeze the moment it settles.
- **Copy on the final answer.** The agent's final reply has a Copy action that puts
  the raw markdown on the clipboard, with inline "Copied" feedback.

### Fixed
- **macOS "app is damaged" on launch.** The bundle is now ad-hoc code-signed
  (`signingIdentity: "-"`), which seals the app's resources and signs the bundled
  `aka-runtime` / `aka-tool` sidecars. Previously only the main binary was
  linker-signed and the bundle seal was missing, so macOS (especially Apple
  Silicon) reported the app as damaged/corrupted both on download and locally.
- **ReAct scaffolding no longer leaks as prose.** `Thought:` / `Action:` /
  `Action Input:` / `Observation:` output from ReAct-style agents (Änyä, Enyö-Änyä,
  any LlamaIndex `ReActAgent`) is now parsed into structured reasoning + tool nodes
  with readable input/output, instead of leaking raw into the reply text.
- **Fonts are fully offline.** The three UI typefaces (Space Mono, Roboto Mono,
  Averia Serif Libre) are now bundled as self-hosted WOFF2 files instead of being
  fetched from the Google Fonts CDN — so typography is correct with no internet,
  matching AKA's local-first promise.

## 1.3.0

### Added
- **Capability-folder tool organization (host-side enforcement core).** Every
  tool AKA knows about is sorted into one of six capability "folders" —
  `fs_read · fs_write · search · git · network · exec` — that define its privilege
  boundary. A new host-side registry keeps a hard split between what the *model*
  sees (a short signpost only) and what the host keeps (folder, scope policy,
  owner, provenance hash, raw annotations).
- **Per-folder default-deny enforcement.** The house layer enforces each folder's
  policy regardless of what a tool claims: writes are blocked outside the project
  root, `git` is approval-gated, and `network` / `exec` are deny-by-default
  (allowlist / explicit opt-in). A tool's self-declared "read-only" hint classifies
  it but never grants trust — if it tries to write out of scope, it's still blocked.
- **Phase routing.** AKA computes which folders are "live" per phase
  (research → plan → edit → review → commit) and exposes only the descriptions of
  live-folder tools to the model, so it can't pick a tool from a folder it never
  saw. Overridable per project.
- **Anchored edits with checkpoint-before-write (`apply_str_replace`).** A safe edit
  primitive enforced for every agent: the path must resolve inside the sandbox, the
  anchor must be non-empty and match exactly once, and the working tree is
  snapshotted before the write — so any edit is undoable, even from a
  non-interactive agent.
- **MCP annotation → folder mapping.** Standard MCP tool annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are mapped
  to capability folders so a *foreign* agent's tool lands in the right privilege
  bucket — untrusted by default. Annotations are retained for classification only,
  never used for an enforcement decision. The live MCP transport and the
  `capability-contract v1` handshake are scaffolded and staged for a follow-up.
- **House-first tool shadowing.** When a foreign agent and AKA both provide a
  same-named tool, AKA's sandboxed built-in wins unless `.äkä/config.json` explicitly
  allows the agent's.
- **Per-project `capabilities` config block** with deny-safe defaults
  (`network_allowlist`, `exec_allow`, `git_requires_approval`, `phase_overrides`,
  `tool_overrides`).

### Changed
- **Cloud is now an explicit network action (local-first hardening).** The built-in
  runtime continues to bind loopback (`127.0.0.1`) only. A local/loopback model is
  ungated as before; a *remote* model endpoint is treated as a `network` action — it
  must be allowlisted (`capabilities.network_allowlist`) and is surfaced to the UI,
  never a silent default. Cloud stays an optional adapter: with no connection, the
  local path keeps working.

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
