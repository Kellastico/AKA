## AKA 1.4.1

A **runtimes-you-can-trust** release: the endpoints you bring now stick around, the pickers scale, agents can drive your dev server, and a few papercuts are gone. Plus the groundwork for a host-driven built-in agent loop.

### ✨ New — Saved (permanent) runtimes
- **Your endpoints persist.** Custom endpoints (OpenRouter, a remote vLLM, …) and the local runtimes you actually use are now kept in a **Saved runtimes** list — shown **above** the Detected list, since they're the ones you care about. Each row has **live health**, an **editable Base URL / API key**, and a **delete**. Deletes stick (a removed runtime won't silently re-appear).
- **Right names.** A runtime restored from your project config no longer shows as `localhost` — detected names (e.g. **Ollama**) are reconciled automatically.

### ✨ New — Search in the model & agent pickers
- Once a list grows past ~10 entries, a **frosted search field** appears so you can type to filter instead of scrolling a long dropdown.

### ✨ New — Agents can drive the dev server
- An agent can **open / kill / restart the dev server** — the *same* server the **Start Dev Server** button controls (URL detection + Preview wiring intact) — by emitting an `@@aka` control marker. Agent- and button-driven control converge on one server.

### ✨ New — Capability probe + posture hint
- A per-session **`--äkä-probe`** handshake auto-locks the model picker for agents that own their own LLM connection (so you don't fight a model you can't change), and the picker shows an **advisory posture recommendation** for the selected model. Advisory only — never forced.

### 🔧 Fixed
- **Modals stop vanishing when you switch apps.** The runtime / model / agent popovers now close only on an **in-app** outside-click — hopping to a password manager to copy an API key no longer dismisses the form mid-edit.
- **Blocked network egress is visible.** A denied (non-allowlisted) endpoint now surfaces a toast instead of failing silently.

### 📝 Good to know — endpoints are OpenAI-compatible
AKA talks to LLMs over the **OpenAI-compatible** shape (`/chat/completions` + Bearer auth). Any such endpoint + key works — OpenAI, **OpenRouter** (the easy path to Claude/Gemini/etc.), Together, Groq, local runtimes, and more. A **raw Anthropic or Google API key** pointed at their native API **won't** work directly (different endpoint/auth/schema); use a gateway like OpenRouter. The Add-custom-endpoint form now says so.

### 🔭 Under the hood
- Foundations for a **host-driven built-in agent loop**: one unified tool catalog projected to both surfaces (the agent CLI and the model), execution-enforcement primitives (an EDIT→REVIEW gate that requires a real on-disk change, an edit **witness** recording the real diff + hash, an approval-gated delete), and a native tool-calling backend. These are **groundwork** — not yet wired into a live loop, so there's no user-facing behavior change here yet.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.4.1_aarch64.dmg`
- **Windows** → `AKA_1.4.1_x64-setup.exe`
- **Linux** → `AKA_1.4.1_amd64.AppImage` (portable) · `AKA_1.4.1_amd64.deb` (Debian/Ubuntu) · `AKA-1.4.1-1.x86_64.rpm` (Fedora/RHEL)

If this macOS build is **unsigned**, right-click → **Open** the first time, or if Gatekeeper says the app is damaged run `xattr -dr com.apple.quarantine /Applications/AKA.app`. On **Windows**, if SmartScreen warns, **More info → Run anyway**. The Linux `.AppImage` needs the executable bit: `chmod +x AKA_1.4.1_amd64.AppImage`.

**Compare:** https://github.com/Kellastico/AKA/compare/v1.4.0...v1.4.1
