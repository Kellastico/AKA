## AKA 1.3.1

A polish release focused on how an agent run *reads*. Reasoning and tool calls
now share one ordered timeline instead of two disconnected accordions — and the
app's fonts are fully bundled, so it looks right with zero internet.

### ✨ Changed
- **Unified run timeline.** Reasoning segments and tool calls now interleave in a
  single, chronologically ordered timeline — the exact order they happened —
  rather than being split into a "reasoning" accordion and a separate "tools"
  accordion. Each step is its own collapsible node on a vertical rail.
- **Live vs settled steps.** Reasoning shows a live streaming preview with a
  "Thinking…" indicator while it streams, then settles to a one-line snippet.
  Tools show a running state with a live timer, then settle to success/error with
  a short result preview.
- **Timing everywhere.** Every reasoning segment and every tool call shows its own
  duration, and a run footer rolls up the total — e.g. `7m 6s · 3.4k tokens · done`.
- **Copy the answer.** The agent's final reply now has a Copy button that puts the
  raw markdown on your clipboard.

### 🔧 Fixed
- **No more ReAct scaffolding in the reply.** `Thought:` / `Action:` /
  `Action Input:` / `Observation:` output from ReAct-style agents is parsed into
  clean tool nodes with readable input/output, instead of leaking as raw prose.
- **Fonts work offline.** The UI typefaces are now bundled with the app instead of
  being fetched from the Google Fonts CDN, so typography is correct with no
  connection — matching AKA's local-first promise.

> No backend/permission changes in this release — it builds on the 1.3.0
> security core and is a safe, drop-in update.

---

### ⬇️ Install

- **macOS** (Apple Silicon) → `AKA_1.3.1_aarch64.dmg` · (Intel) → `AKA_1.3.1_x64.dmg`
- **Windows** → `AKA_1.3.1_x64-setup.exe`
- **Linux** → `AKA_1.3.1_amd64.AppImage` (portable) · `AKA_1.3.1_amd64.deb` (Debian/Ubuntu) · `AKA-1.3.1-1.x86_64.rpm` (Fedora/RHEL)

This is an unsigned build. On **macOS**, right-click the app → **Open** the first
time (or run `xattr -dr com.apple.quarantine /Applications/AKA.app`). On
**Windows**, if SmartScreen warns, choose **More info → Run anyway**. The Linux
`.AppImage` needs the executable bit: `chmod +x AKA_1.3.1_amd64.AppImage`.

**Full changelog:** https://github.com/Kellastico/AKA/blob/main/CHANGELOG.md
**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.0...v1.3.1
