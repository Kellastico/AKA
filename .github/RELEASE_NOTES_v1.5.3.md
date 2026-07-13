## AKA 1.5.3

The release that removes AKA's last model opinion. Until now, the built-in **Execute/Strategize** loop decided *how* to offer tools — native tool-calling API vs the text protocol — by matching your model's **name** against a hardcoded list of known families. That's exactly the kind of opinion AKA promises not to have, and it misrouted models: a tool-capable model with an unrecognized name got the weaker text path for no reason.

### 🧭 Tool routing by evidence, not by name
The transport decision is now made the way everything in AKA should be — by asking, observing, and remembering:

1. **Ask the runtime.** Runtimes that self-report per-model capabilities (Ollama's `/api/show` lists `"tools"` per model) answer the question directly — including for your own custom model tags the old list had never heard of.
2. **Try it.** When the runtime doesn't self-report (generic OpenAI-compatible endpoints, gateways), AKA starts **optimistically with the native tools API** for *every* model. If the endpoint rejects the request, the run **falls back to the text protocol automatically and finishes the same task there** — with a visible note on the timeline, never a silent downgrade. Auth and rate-limit errors are *not* treated as capability signals; they surface as the real errors they are.
3. **Remember.** What a session observes (native worked / endpoint refused) is cached per runtime + model and drives the next run's choice. Observation always outranks advertisement.

The old name heuristic no longer carries any routing weight. Unknown model? Unknown runtime? You still get offered the best transport it can actually support.

### 🔎 The reliability nudge got honest too
The 1.5.2 advisory ("this model uses the text fallback") was driven by the same name list — so it could nag a perfectly tool-capable model. It's now driven by the same evidence: it appears only when the runtime *reports* no tool support for your selected model, or a run *actually* fell back. Nothing known yet → no nudge, because the loop will try the native path first anyway.

### Why this matters
Custom quants, fine-tunes, renamed tags, brand-new releases, gateway models — none of them need AKA's permission list anymore. If your model can call tools, it gets the native path. If it can't, it gets the text protocol and a truthful heads-up. Either way, the same enforcement applies: phase gates, approval modes, checkpoints, sandbox.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.5.3_aarch64.dmg`
- **Windows** → `AKA_1.5.3_x64-setup.exe`
- **Linux** → `AKA_1.5.3_amd64.AppImage` (portable) · `AKA_1.5.3_amd64.deb` (Debian/Ubuntu) · `AKA-1.5.3-1.x86_64.rpm` (Fedora/RHEL)
