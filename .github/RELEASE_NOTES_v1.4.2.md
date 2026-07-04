## AKA 1.4.2

The release where **the model can finally look at your code** — and where you can bring **any key**: OpenAI-compatible, Anthropic, or Google Gemini, pasted straight into the same box.

### ✨ New — Strategize actually strategizes
Pick **None** in the Agent picker + **Strategize** mode, and AKA now drives your model through a real **read-only tool loop**: it can `read` files, `list` directories, `search` the codebase, and run your configured `diagnostics` (typecheck/lint) — grounded from the first turn in *your* project (name, root, top-level layout), with every tool call rendered as a live card on the timeline.

- **Read-only by construction.** In Strategize, no write or exec tool is even advertised to the model — it can see and understand everything, and change nothing. Writes/exec arrive in a later release behind checkpoints + approval.
- **Works with big and small models.** Models with native tool-calling get the clean native loop; models without it get a compact text protocol — same tools, same enforcement, same cards.
- **You stay in control.** Stop works mid-loop, and a step budget stops a confused model from spinning.

### ✨ New — bring ANY key: Anthropic and Google Gemini, natively
The Add-custom-endpoint box now speaks three protocols, **auto-detected from the URL**:
- **OpenAI-compatible** (OpenAI, OpenRouter, Ollama, LM Studio, vLLM, …) — as always.
- **Anthropic** — paste `https://api.anthropic.com` + your `sk-ant-…` key.
- **Google Gemini** — paste `https://generativelanguage.googleapis.com` + your API key.

Chat, streaming (including thinking/reasoning deltas), the Strategize tool loop, model listing, and health checks all work through each provider's native API. No gateway required.

### 🔧 Fixed & sharpened
- **Honest API errors.** A provider that *rejects* a request (bad key, rate limit, out of credits) now shows as an **API error with the provider's own message** — no longer misread as "runtime offline" or an agent failure.
- **Cleaner conversations on the wire.** A new message validator sanitizes every request (empty messages, malformed tool pairings) before it reaches any provider, preventing a class of confusing 400s from local runtimes.
- **Strategize knows where it is.** The model is grounded in the project's name, path, and top-level structure before its first turn — no more "which project am I in?".

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.4.2_aarch64.dmg`
- **Windows** → `AKA_1.4.2_x64-setup.exe`
- **Linux** → `AKA_1.4.2_amd64.AppImage` (portable) · `AKA_1.4.2_amd64.deb` (Debian/Ubuntu) · `AKA-1.4.2-1.x86_64.rpm` (Fedora/RHEL)

If this macOS build is **unsigned**, right-click → **Open** the first time, or if Gatekeeper says the app is damaged run `xattr -dr com.apple.quarantine /Applications/AKA.app`. On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.4.2_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.4.1...v1.4.2
