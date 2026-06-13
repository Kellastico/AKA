## AKA 1.0.3

Reasoning models now behave, imported projects start clean, and the Preview
pane reloads like a real browser.

### 🐛 Fixed
- **Reasoning no longer leaks into the chat.** Thinking models whose chat
  template prefills the `<think>` opener (Mellum 2-Thinking, DeepSeek-R1, and
  similar) emit only a closing `</think>` — which slipped past the old parser,
  spilling raw reasoning and a stray `</think>` into the message body. The
  stream parser now handles prefilled/orphan close tags, tags split across
  chunks, and native `reasoning` / `reasoning_content` fields when the runtime
  separates thinking for us.
- **No more lingering chat on import.** Importing a project — even one named
  similarly to an existing one — used to show the previous project's chat.
  Every imported project now opens in its own fresh session.

### ✨ Added
- **Live reasoning containment.** AKA learns which models prefill their
  thinking block and routes their reasoning straight to the Reasoning
  accordion as it streams — including in agent mode, where tool calls cut a
  model off mid-thought. Detected and remembered per model; nothing hardcoded.
- **Hard reload in the Preview pane.** ⇧-click the reload button to clear the
  webview's HTTP cache before refetching. Normal reloads now cache-bust the
  iframe too, so dev servers without no-cache headers (python `http.server`,
  `serve`, …) can't leave the preview stale.

### 🔧 Changed
- **File watcher catches deletions and static builds.** It now tracks file
  count alongside modification time, so deleting a file rolls the preview
  forward, and the `dist` directory is watched so static-build output updates
  the preview.
- Refreshed preview screenshots.

---

**Full changelog:** https://github.com/Kellastico/AKA/blob/main/CHANGELOG.md
**Compare:** https://github.com/Kellastico/AKA/compare/v1.0.2...v1.0.3
