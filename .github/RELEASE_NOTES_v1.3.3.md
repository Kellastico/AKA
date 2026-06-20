## AKA 1.3.3

This release makes an agent run **readable and honest**: the model now thinks out
loud in order on the timeline, the Files pane stays live as work happens, and a
batch of "stuck run" and "garbled output" glitches are gone.

### ✨ Changed
- **Reasoning, out loud and in order.** The run timeline prints each thought
  inline exactly where it happened — only **Action Input / Tool Calls** sit
  behind accordions. The old "Worked" header and surrounding container are gone,
  so a run reads straight down the thread instead of hiding the model's thinking.
- **Copy your own messages too.** The labeled **Copy** button from the agent's
  final reply now also sits on the messages you send, with "Copied" feedback.
- **Live Files pane.** When you — or an agent — create, edit, or delete files,
  the Files pane updates itself instead of showing a stale snapshot. (Shared,
  reference-counted watcher, so it never fights the Preview pane.)

### 🔧 Fixed
- **No more stuck runs.** A bailed or wedged agent no longer pulses "working"
  forever: abandoned runs are finalized, stale "thinking" timers stop climbing,
  and a watchdog clears a genuinely silent run on its own.
- **Cleaner agent output.** Terminal spinner/control characters and the internal
  capability-contract handshake no longer leak into chat as garbled text or
  stray ▯ boxes, and a stray `<think>` tag from prefill-thinking models is
  stripped.
- **Clearer runtime startup.** A runtime that fails to boot (e.g. MLX) now
  reports the real reason instead of silently doing nothing.
- **Backend resilience.** A poisoned mutex now recovers instead of cascading
  into a backend crash.

> Builds on the 1.3.x line; no permission changes. macOS builds remain ad-hoc
> signed (1.3.1's "app is damaged" fix carries forward).

---

### ⬇️ Install

- **macOS** (Apple Silicon) → `AKA_1.3.3_aarch64.dmg`
- **Windows** → `AKA_1.3.3_x64-setup.exe`
- **Linux** → `AKA_1.3.3_amd64.AppImage` (portable) · `AKA_1.3.3_amd64.deb` (Debian/Ubuntu) · `AKA-1.3.3-1.x86_64.rpm` (Fedora/RHEL)

Unsigned by an Apple cert: on **macOS**, right-click → **Open** the first time
(or `xattr -dr com.apple.quarantine /Applications/AKA.app`). On **Windows**, if
SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the
executable bit: `chmod +x AKA_1.3.3_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.2...v1.3.3
