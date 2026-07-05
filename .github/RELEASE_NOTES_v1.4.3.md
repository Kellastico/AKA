## AKA 1.4.3

A **sharpening release** — no new headline features, just making what shipped in 1.4.2 work the way it should for the two people AKA is built for: someone on **limited hardware (<16 GB)** who deserves near-frontier results from a small local model, and someone with **cloud keys** who wants to just build — with their data leaving the machine only with their knowledge *and* consent.

### 🪶 For limited hardware — small models stop drowning
- **`read_file` is now paged.** One big file used to dump up to 100 KB (~25k tokens) into the conversation — instantly blowing an 8k-context local model. Results are now capped at ~24 KB, `read_file` takes `offset`/`limit`, and the truncation marker tells the model *exactly* how to continue (`offset=<next line>`). Small models page instead of drowning; frontier models lose nothing.
- **The context meter is honest during Strategize.** The loop's real prompt — tool results included — was invisible to the transcript-based meter. The loop now reports its true serialized size before every model turn, so the meter reflects what the model actually sees, and you know when a small context is filling up *before* quality falls off a cliff.
- Diagnostics output is capped to the same context-safe size.

### 🔐 For cloud keys — consent is honored, not re-asked
- **Adding an endpoint is the consent moment.** Pasting a remote URL + key (OpenRouter, Anthropic, Gemini, …) now opens the egress gate for **exactly that host** — no more "network egress blocked, go edit Capabilities" toast on your first chat with a runtime you just deliberately configured. Everything you did *not* add stays deny-by-default; the allowlist remains visible and editable under Capabilities.
- Projects that already carried a remote endpoint from an older version are honored the same way on load — stored consent counts.

### 🧹 Cleanup
- **Removed a real config trap:** a stale compiled `vite.config.js` was tracked in the repo and — because Vite resolves `.js` before `.ts` — silently shadowed the real `vite.config.ts`. It's gone, ignored, and TypeScript build artifacts now emit into the cache instead of the project root, so the trap can't come back.
- Architecture docs updated to match what actually shipped (the read-only loop and provider adapters are no longer described as "planned").

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.4.3_aarch64.dmg`
- **Windows** → `AKA_1.4.3_x64-setup.exe`
- **Linux** → `AKA_1.4.3_amd64.AppImage` (portable) · `AKA_1.4.3_amd64.deb` (Debian/Ubuntu) · `AKA-1.4.3-1.x86_64.rpm` (Fedora/RHEL)

If this macOS build is **unsigned**, right-click → **Open** the first time, or if Gatekeeper says the app is damaged run `xattr -dr com.apple.quarantine /Applications/AKA.app`. On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.4.3_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.4.2...v1.4.3
