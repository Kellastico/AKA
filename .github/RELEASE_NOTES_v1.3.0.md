## AKA 1.3.0

AKA now treats every agent as **untrusted by default**. This release adds a
local, default-deny permission layer that decides what a tool is actually allowed
to do — no matter what the tool or agent claims. It's the foundation for safely
hosting *foreign* agents, and it runs fully on-device with zero internet.

### ✨ Added
- **Capability folders.** Every tool is sorted into one of six privilege buckets —
  `fs_read · fs_write · search · git · network · exec`. The agent only ever sees a
  short, model-facing signpost for each tool; everything that governs trust and
  enforcement stays host-side.
- **Default-deny enforcement (the house layer).** AKA enforces each folder's policy
  itself: writes are blocked outside your project, `git` is approval-gated, and
  `network` / `exec` are denied unless you opt them in. A tool can *claim* it's
  read-only — that only sorts it; the moment it tries to write out of bounds, it's
  still blocked. Hints classify; AKA enforces.
- **Phase-aware tools.** A job moves through research → plan → edit → review →
  commit, and the agent is only shown the tools that are safe for the current
  phase. You can't misuse a tool you were never handed.
- **Safer edits with one-click undo.** A new anchored edit primitive only changes a
  file when its target snippet matches **exactly once**, and snapshots your project
  right before every write — so any agent edit is reversible, even from an agent
  that never stops to ask.
- **Foreign-agent support over MCP (foundation).** Tools from agents that have never
  heard of AKA are automatically dropped into the right privilege bucket from their
  standard MCP annotations, so the same rules apply to them. The live MCP connection
  and handshake are scaffolded for a follow-up release.

### 🔧 Changed
- **Local-first, made explicit.** The built-in model runtime binds to your machine
  only (`127.0.0.1`). Local models are ungated as always; pointing AKA at a **cloud**
  model is now treated as a network action — it has to be explicitly allowed and is
  surfaced to you, never a silent default. No connection? The local path just keeps
  working.

> Mostly a security & architecture release: there's no major new UI, but the
> groundwork here is what lets AKA host third-party agents without handing them the
> keys.

---

### ⬇️ Install

- **macOS** (Apple Silicon) → `AKA_1.3.0_aarch64.dmg` · (Intel) → `AKA_1.3.0_x64.dmg`
- **Windows** → `AKA_1.3.0_x64-setup.exe`
- **Linux** → `AKA_1.3.0_amd64.AppImage` (portable) · `AKA_1.3.0_amd64.deb` (Debian/Ubuntu) · `AKA-1.3.0-1.x86_64.rpm` (Fedora/RHEL)

This is an unsigned build. On **macOS**, right-click the app → **Open** the first
time (or run `xattr -dr com.apple.quarantine /Applications/AKA.app`). On
**Windows**, if SmartScreen warns, choose **More info → Run anyway**. The Linux
`.AppImage` needs the executable bit: `chmod +x AKA_1.3.0_amd64.AppImage`.

**Full changelog:** https://github.com/Kellastico/AKA/blob/main/CHANGELOG.md
**Compare:** https://github.com/Kellastico/AKA/compare/v1.2.1...v1.3.0
