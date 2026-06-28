## AKA 1.4.0

This release is about **the newest model, the day it drops.** Until now you could only one-click the models AKA had hand-picked. From 1.4, the whole of HuggingFace's GGUF catalog is one search away — and it gets there without ever loosening AKA's local-first, nothing-runs-on-your-machine promise.

### ✨ New — Add any model from HuggingFace
- **Search or paste, then download.** The Models browser has a new **Add from HuggingFace** panel. Type a search (e.g. *"qwen coder"*) and pick from results ranked by popularity, **or** paste a repo (`owner/name` or a full `huggingface.co/…` URL) to jump straight to its files. Choose a quant (Q4/Q6/Q8…) and it downloads into the built-in runtime exactly like a curated model — same progress, same RAM gate, same one-click load.
- **Community models are clearly marked.** Anything outside AKA's tested set carries the **Unverified** badge and is still held to the RAM gate, so you always know what's vetted and what you're trying at your own risk. No model is ever blocked — that's your call.

### 🔒 Safety — discovery that stays local-first
Pulling models from the internet is exactly where a desktop app can get a user hurt, so the new path is deliberately narrow:
- **Host-pinned to huggingface.co.** A pasted value is only ever treated as a `owner/name` path — it can't redirect a download off-host or traverse the API. Off-host, malformed, and `..` inputs are rejected outright.
- **`.gguf` only — never executable.** AKA downloads and loads *only* GGUF weights through the local sidecar. The classic HuggingFace attack — pickle (`.bin`/`.pt`) files that run code the moment they're loaded — simply has no path here.
- **Nothing runs on fetch.** Search returns plain metadata (names, sizes); the only thing written to disk is a magic-byte-validated GGUF. Inference is 100% local, as always.
- Multi-part (sharded) GGUF files are detected and shown disabled, so you can't half-download a model that won't load.

### 🔏 Changed — macOS builds are now signed & notarized
This is the first release built with **Developer ID signing + notarization**. On a clean Mac the `.dmg` should now open normally — no more "disk image is damaged" and no right-click → Open dance. (If your download was interrupted or you're on an older macOS, the fallback below still works.)

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.4.0_aarch64.dmg`
- **Windows** → `AKA_1.4.0_x64-setup.exe`
- **Linux** → `AKA_1.4.0_amd64.AppImage` (portable) · `AKA_1.4.0_amd64.deb` (Debian/Ubuntu) · `AKA-1.4.0-1.x86_64.rpm` (Fedora/RHEL)

macOS is now notarized — just drag to Applications and open. If a download was interrupted and Gatekeeper still complains, run `xattr -dr com.apple.quarantine /Applications/AKA.app`. On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.4.0_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.6...v1.4.0
