## AKA 1.3.2

More polish on the run timeline — tidier tool grouping, copy on both sides of a
turn, and accurate tool names from ReAct agents.

### ✨ Changed
- **Tools group under their reasoning.** Tool calls that follow a Thought now
  render as compact chips, and **3+ in a row collapse into one accordion**
  ("Read 3 files", "Ran 3 commands"…) so a busy run stays readable. One or two
  tools stay inline; expand a group to see each call.
- **Copy your message and the reply.** A copy button now sits on your own sent
  messages (by the timestamp) as well as the agent's final output — each with
  "Copied" feedback.

### 🔧 Fixed
- **Correct tool names from ReAct agents.** When a model writes the next step on
  the same line as its reasoning — "…list the files.Action: list_directory" —
  the parser now still captures it, so tool nodes show the real name instead of
  a generic "tool", and `Action:`/`Observation:` scaffolding no longer leaks
  into the reasoning. Keyword-like text inside a tool's output is left as-is.

> Builds on the 1.3.x line; no backend/permission changes. macOS builds remain
> ad-hoc signed (1.3.1's "app is damaged" fix carries forward).

---

### ⬇️ Install

- **macOS** (Apple Silicon) → `AKA_1.3.2_aarch64.dmg`
- **Windows** → `AKA_1.3.2_x64-setup.exe`
- **Linux** → `AKA_1.3.2_amd64.AppImage` (portable) · `AKA_1.3.2_amd64.deb` (Debian/Ubuntu) · `AKA-1.3.2-1.x86_64.rpm` (Fedora/RHEL)

Unsigned by an Apple cert: on **macOS**, right-click → **Open** the first time
(or `xattr -dr com.apple.quarantine /Applications/AKA.app`). On **Windows**, if
SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the
executable bit: `chmod +x AKA_1.3.2_amd64.AppImage`.

**Full changelog:** https://github.com/Kellastico/AKA/blob/main/CHANGELOG.md
**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.1...v1.3.2
