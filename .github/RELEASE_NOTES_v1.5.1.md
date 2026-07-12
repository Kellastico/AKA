## AKA 1.5.1

A reliability patch for the built-in **Execute** loop shipped in 1.5.0. If you selected **None + Execute** with a local model and saw **"[the model produced no answer]"** — sometimes over and over — this release is for you.

### 🐛 The bug: one blank turn killed the whole run
The built-in loop was giving up the instant a model turn came back empty. But local models — especially quantized ones served through Ollama — intermittently return an **empty completion** (a blank response with a clean stop, not an error). It's a transient decode hiccup: the very next attempt almost always succeeds. AKA was treating that first blank as "the model has nothing to say" and ending the run, so a perfectly capable model looked broken.

To be clear about what was *never* the problem: tool use itself works regardless of whether an external agent is attached. With **None**, AKA drives the model through its own tool loop — native tool-calls when the model supports them, a compact text protocol when it doesn't. That path was fine; it just wasn't resilient to a blank turn.

### ✅ The fix: retry blank turns instead of surrendering
- **Empty turns are now re-asked** (up to a few times) before the loop concludes the model is done. Both loop paths — native tool-calling and the text protocol — recover automatically, so an occasional blank response no longer strands the run.
- **You can see it happen.** A retry surfaces a brief "the model returned an empty response — retrying…" note on the timeline instead of a silent pause, so a slow-but-alive run never looks frozen.
- **A clearer dead-end message.** If a model *keeps* returning nothing even after retries, AKA now says so plainly — "this model may be unreliable for tool use; try again, rephrase, or pick a different model" — instead of the opaque "[the model produced no answer]".
- **Longer cold-load grace.** A large local model loading into memory on its first call had a 120-second ceiling and could be misread as "runtime not reachable." The direct completion path now waits up to 180 seconds, matching the tool-calling path — enough for a 12B to warm up before generating.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.5.1_aarch64.dmg`
- **Windows** → `AKA_1.5.1_x64-setup.exe`
- **Linux** → `AKA_1.5.1_amd64.AppImage` (portable) · `AKA_1.5.1_amd64.deb` (Debian/Ubuntu) · `AKA-1.5.1-1.x86_64.rpm` (Fedora/RHEL)
