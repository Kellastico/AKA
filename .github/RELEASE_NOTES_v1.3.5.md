## AKA 1.3.5

This release tightens the run timeline and the Preview pane around one idea: **never leave you guessing.** Tool bursts tidy themselves, a run always shows *something* even when the agent forgets to answer, freeing a port tells you it worked, and the chat stops yanking you to the bottom while you're reading.

### ✨ Changed
- **Tool bursts collapse.** A run of 3+ tool calls with no thinking between them folds into one flat accordion (`Running N tools` / `Read 3 files`) in its place; reasoning and 1–2-tool spans stay inline and chronological.
- **Settled runs fold away.** Once a run finishes and has its answer, the whole reasoning + tool timeline collapses into a single "Worked for Xs" accordion above the answer (expand to see every step) — live runs still stream inline.
- **No more scroll-jacking.** While the agent is thinking or answering, new reasoning/tool/answer messages no longer yank you back to the bottom if you've scrolled up — only your own send re-anchors. Use Scroll-to-Bottom (or scroll down) to re-pin.

### 🔧 Fixed
- **Runs no longer come back empty.** When an agent finishes its tools without emitting a final answer, AKA now surfaces the model's final step as the reply (labelled "Recovered…"), or — if there's nothing to surface — shows an explicit "finished without a final answer" notice instead of a blank. (Root cause is usually the agent itself; this makes the outcome visible either way.)
- **Freeing a port confirms itself.** Clicking Auto-fix on a "port in use" failure now fires a toast (`Port 8000 is now free`) and replaces the failure banner with a one-click **Restart dev server** button, instead of silently running and leaving you to guess.

> Builds on the 1.3.x line; no permission changes. macOS builds remain ad-hoc signed — right-click → **Open** on first launch.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.3.5_aarch64.dmg`
- **Windows** → `AKA_1.3.5_x64-setup.exe`
- **Linux** → `AKA_1.3.5_amd64.AppImage` (portable) · `AKA_1.3.5_amd64.deb` (Debian/Ubuntu) · `AKA-1.3.5-1.x86_64.rpm` (Fedora/RHEL)

Unsigned by an Apple cert: on **macOS**, right-click → **Open** the first time (or `xattr -dr com.apple.quarantine /Applications/AKA.app`). On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.3.5_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.4...v1.3.5
