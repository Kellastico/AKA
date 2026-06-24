## AKA 1.3.6

This release is about **trusting the tools to do the right thing on their own** — a slow local model is no longer mistaken for a dead one, and a static site no longer gets handed a command that was always going to fail.

### ✨ Changed
- **Slow agents are never killed anymore.** The watchdog used to assume 3 minutes of silence meant a wedged process and kill it — but local models can legitimately churn for many minutes (especially on images). AKA now waits 6 minutes, then shows a non-blocking **"agent may be stale"** notice on the live run (and a toast) while it keeps standing by. The warning clears the instant output resumes, so a slow-but-alive run recovers on its own. Stop stays yours to press.

### 🔧 Fixed
- **Static sites with a stray `package.json` now start.** The dev-server detector checked Node first, so any folder carrying a `package.json` — even one with no `dev`/`start`/`serve` script — was handed `npm run dev`, which died on `Missing script: dev` and left the Preview pane looping through Reconfigure. AKA now recognizes that case: when there's no runnable script but an `index.html` is present, it serves the folder as static HTML (`python3 -m http.server 8000`) instead.
- **"Missing script" failures now explain themselves.** If `npm run <script>` ever does fail for a missing script, the Preview banner names the script and points you at the static-HTML command, instead of the generic "check the Output pane."

> Builds on the 1.3.x line; no permission changes. macOS builds remain ad-hoc signed — right-click → **Open** on first launch.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.3.6_aarch64.dmg`
- **Windows** → `AKA_1.3.6_x64-setup.exe`
- **Linux** → `AKA_1.3.6_amd64.AppImage` (portable) · `AKA_1.3.6_amd64.deb` (Debian/Ubuntu) · `AKA-1.3.6-1.x86_64.rpm` (Fedora/RHEL)

Unsigned by an Apple cert: on **macOS**, right-click → **Open** the first time (or `xattr -dr com.apple.quarantine /Applications/AKA.app`). On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.3.6_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.5...v1.3.6
