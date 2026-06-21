## AKA 1.3.4

This release polishes the run timeline into **one calm, honest surface** and kills a class of status/counter glitches: the model's thinking and tool calls now read straight down the thread in one typeface, edits show a real diff, failures explain themselves, and the "is it still running?" signals finally agree with each other.

### ✨ Changed
- **One unified type surface.** Reasoning now renders in the same font as the final answer (Space Mono), so thinking, tool I/O, and the reply read as a single surface instead of two different voices.
- **Flat, chronological timeline.** Reasoning and tool calls interleave inline in the exact order they happened — no grouping accordion, no boxy chrome. Each tool call is a compact chip that hugs its content; expanding it keeps the full width for the detail.
- **See exactly what the tool did.** Tool panels show the real call and result (Query / Results, Command / Output, Arguments / Contents) instead of a generic blurb. `edit_file` shows a colour-coded **diff and nothing else**, so you can pinpoint precisely what changed.
- **The final answer stands apart.** A top border now separates the model's reply from the reasoning above it.
- **Honest run timing.** The run total now folds in the LLM's boot / load + time-to-first-token, so the elapsed figure reflects true end-to-end latency — how fast or slow your local model really is. Run status reads `Running` / `Done` / `Error` (capitalised).

### 🔧 Fixed
- **Run status can't lie anymore.** The footer no longer shows "Done" while the composer's stop button still says the run is live (or vice versa) — both now read the same in-flight flag and flip together.
- **Failures explain themselves.** When a run errors, the timeline now shows the exit code, the stderr tail, and a plain-English hint inline — instead of only flipping the footer to "Error" with no reason.
- **Token counts that add up.** A run's token footer and the context-window meter now use one shared estimator, so a single run can never report more tokens than the whole session. (Both remain `~` estimates: in agent mode AKA can't see the agent's real prompt/usage.)

> Builds on the 1.3.x line; no permission changes. macOS builds remain ad-hoc signed — right-click → **Open** on first launch.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.3.4_aarch64.dmg`
- **Windows** → `AKA_1.3.4_x64-setup.exe`
- **Linux** → `AKA_1.3.4_amd64.AppImage` (portable) · `AKA_1.3.4_amd64.deb` (Debian/Ubuntu) · `AKA-1.3.4-1.x86_64.rpm` (Fedora/RHEL)

Unsigned by an Apple cert: on **macOS**, right-click → **Open** the first time (or `xattr -dr com.apple.quarantine /Applications/AKA.app`). On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.3.4_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.3...v1.3.4
