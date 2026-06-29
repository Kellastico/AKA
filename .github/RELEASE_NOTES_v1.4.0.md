## AKA 1.4.0

This release opens up **the zero-setup, bring-any-model path** — search and download the newest models straight from HuggingFace, run them with no agent at all if your stack lives on the model side, and find everything you've downloaded in one place. Plus a fix so Vite projects preview correctly.

### ✨ New — Add any model from HuggingFace
- **Search or paste, then download.** The Models browser has an **Add Model (via Huggingface)** panel: search the GGUF catalog (ranked by popularity) **or** paste a repo (`owner/name` or a full `huggingface.co/…` URL), pick a quant (Q4/Q6/Q8…), and it downloads into the built-in runtime exactly like a curated model — same progress, RAM gate, and one-click load.
- **Community models are clearly marked** with an **Unverified** badge and held to the RAM gate. Nothing is ever blocked — your call.

### ✨ New — "None" agent
- A first-class **None** option in the Agent picker, for setups whose agentic layer lives on the model side (an ICM / SAFE framework, or any non-Python-agent flow). AKA attaches no subprocess and relays your task straight to the model. A brand-new install now defaults to **None + Chat Only** — runnable the moment a runtime and model are connected, with no agent to install.

### ✨ New — one central models folder
- Every model you download or import lands in one place, and the Models browser now shows that path with a click-to-reveal **"Saved to …"** line — open it in Finder/Explorer/Files without spelunking the OS app-data tree.

### 🔒 Safety — discovery stays local-first
The HuggingFace path is deliberately narrow: **host-pinned to huggingface.co** (a pasted value can't redirect a download off-host), **`.gguf`-only** (the classic pickle/`.bin` code-on-load attack has no path here), and **nothing is executed on fetch** — search returns plain metadata; the only artifact written is a magic-byte-validated GGUF, loaded by the local sidecar. Sharded multi-part files are detected and disabled.

### 🔧 Fixed
- **Vite projects preview correctly.** The dev-server detector ignored `vite.config.*`, so a Vite app (which has a root `index.html`) could fall back to a Python static server on `:8000` — which 404s Vite's `/src` entry and renders blank. A `vite.config.{js,mjs,ts,cjs,mts,cts}` now takes precedence and runs the Vite dev server (localhost:5173); a real `npm run dev` script still wins when present.

### 🔭 Under the hood
- The context-usage meter can now reflect an **agent's real prompt size** when the agent reports it live, instead of only estimating from the visible transcript.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.4.0_aarch64.dmg`
- **Windows** → `AKA_1.4.0_x64-setup.exe`
- **Linux** → `AKA_1.4.0_amd64.AppImage` (portable) · `AKA_1.4.0_amd64.deb` (Debian/Ubuntu) · `AKA-1.4.0-1.x86_64.rpm` (Fedora/RHEL)

This macOS build is **unsigned** (Developer ID signing returns next release). On **macOS**, right-click → **Open** the first time, or if Gatekeeper says the app is damaged run `xattr -dr com.apple.quarantine /Applications/AKA.app`. On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.4.0_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.3.6...v1.4.0
