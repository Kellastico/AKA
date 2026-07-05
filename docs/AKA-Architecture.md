# AKA Architecture — Capability-Aware Posture

Status: **Living doc.** Sections marked _(implemented)_ describe shipped behavior;
_(planned)_ sections pin a contract that companion work (host- or agent-side)
implements against.

This document is the source of truth for the **posture spectrum** and the
**host→agent capability contract**. It exists so the agent-side work (Änyä/Enyö
honoring the dial) can implement against a stable spec without reading host code.

---

## 1. The load-bearing rule

> **Unconstrain capability, never safety.**

Every posture — including None — keeps the full house safety layer:

- **Default-deny, folder-scoped tool policy** (`src-tauri/src/tools/`): `fs_read ·
  fs_write · search · git · network · exec`. Reads/search are allowed within
  project scope; everything that mutates, spends, or reaches out is deny-by-default
  and can only be *narrowed* by config, never widened (`tools::policy::narrow`).
- **Working-tree checkpoints** (`src-tauri/src/commands/checkpoints.rs`): real git
  commits parked under the private `refs/aka/checkpoints/<run_id>/<seq>` namespace
  (invisible to `git log/status/branch/stash`), snapshotted pre- and post-run.
  (Note: implemented via the `git` CLI + private refs, _not_ the `git2` crate or a
  shadow branch — historical naming.)
- **The trust split**: house-owned tools are trusted-by-construction and sandboxed;
  foreign/agent tools are untrusted and run only under full house policy. MCP
  annotations are untrusted hints used for *classification*, never enforcement.

The posture dial changes how much **scaffolding** the host wraps around the model.
It never changes what the house layer permits.

---

## 2. The posture spectrum

```
None  ───────  thin  ───────  thick  ───────  orchestrated
(no harness)   (light, native   (text ReAct,    (full orchestrator,
 raw model +    tool-calls,      tighter gates)   least-privilege
 house loop)    loose gating)                     sub-agents)
```

Match posture to model capability — **thin for strong models, thick for weak**:

| Strength class | Recommended posture | Rationale |
|----------------|---------------------|-----------|
| `frontier`     | None                | Strong model needs no scaffolding; max autonomy. |
| `local-large`  | thin                | Light harness, native tool-calls when supported. |
| `local-small`  | orchestrated        | Full orchestrator carries a weak model. |

The recommendation is **advisory** — surfaced as a badge in the agent picker,
never forced. The user always overrides. Nothing is auto-applied unless the
`autoApplyPosture` opt-in (per-user pref) is on _(implemented: classifier +
recommendation + advisory badge; auto-apply opt-in present)_.

The spectrum is **agent-agnostic**: thin/thick/orchestrated are *intensity
levels*, not specific agents. AKA ships no agent catalog. A posture-aware agent
(e.g. the user's Änyä/Enyö) realizes a posture by honoring the env contract below;
the conceptual mapping is Änyä-thin ↔ `thin`, Änyä-thick ↔ `thick`, Enyö ↔
`orchestrated`.

---

## 3. The capability classifier _(implemented)_

`src/lib/model-posture.ts` classifies a model id across three axes, best-effort
and string-based (the safe default is the *thicker* posture — an unknown model is
assumed weak and tool-call-incapable, so it gets more help, never less safety):

- **native tool-calling** (`supportsNativeToolCalling`) — known OpenAI
  `tools`/`tool_calls` families; everything else `false`.
- **strength** (`classifyStrength`) — `local-small | local-large | frontier`.
- **profile/size tier** (`profileTier`) — `small | mid | large`.

`mergeServerCapabilities` lets a server-reported capability list (e.g. newer
Ollama `/api/show` exposing `"tools"`) override the tool-calling heuristic when
available. OpenAI-compatible endpoints expose no such metadata, hence the
heuristic floor.

---

## 4. The host→agent env contract _(implemented: host emits)_

When a posture other than None is active, the host emits the capability dial to
the spawned agent **alongside** the existing `AKA_*` contract
(`src-tauri/src/commands/agent_runner.rs`, `posture_env`). The values are derived
frontend-side (`postureToDial` in `model-posture.ts`) so the heuristic lives in
one place; the host only relays them.

| Env | Values | Meaning |
|-----|--------|---------|
| `AGENT_PROFILE`  | `small \| mid \| large` | Model size tier (the original `--auto-profile` axis). |
| `AGENT_TOOLCALL` | `native \| text`        | `native` → skip text-ReAct parsing, use provider tool-calling. `text` → text ReAct. **`native` only when the model supports it** — capability gates the dial. |
| `AGENT_GATING`   | `loose \| strict`       | `loose` → widen per-step tool visibility, relax phase gates. `strict` → tighter. |
| `AGENT_LEASH`    | integer                 | Max autonomous steps before an orchestrator intervenes. Larger → more autonomy. |

Posture → dial mapping (`postureToDial`):

| Posture       | `AGENT_TOOLCALL`        | `AGENT_GATING` | `AGENT_LEASH` |
|---------------|-------------------------|----------------|---------------|
| thin          | `native` if supported, else `text` | `loose`  | 24 |
| thick         | `text`                  | `strict`       | 12 |
| orchestrated  | `text`                  | `strict`       | 6  |

**Agent-side contract** _(planned — separate companion task)_: a posture-aware
agent reads these and adjusts; an agent that doesn't recognize them ignores the
unknown env, so emitting the dial is a **safe no-op** and never regresses an
existing agent. None spawns no subprocess, so it emits no `AGENT_*` env.

> Note on None vs. a spawned agent: a `frontier` model recommends None (no
> harness). If the user nonetheless runs a subprocess agent with a frontier
> model, the dial collapses None → `thin` (the thinnest *real* harness), since a
> subprocess agent is being spawned and "no harness" doesn't apply to it.

---

## 5. The None posture _(SHIPPED read-only in v1.4.2; writes/exec = v1.5)_

"None" = no third-party agent; AKA drives the model directly through its own
loop (`src/lib/builtin-loop.ts`, wired in `use-chat-store.ts`), exposing the
house tool layer (folder-scoped, default-deny). What ships today:

- **None + Strategize** runs the READ-ONLY loop: `read_file` (paged —
  `offset`/`limit`, ~24 KB/result cap so small-context models survive),
  `list_dir`, `search_files`, `diagnostics`. The system prompt grounds the model
  in the project (name, root, top-level listing) before its first turn, and the
  loop reports its real prompt size to the context meter every turn.
- **Transport is capability-detected**: native `tools`/`tool_calls` when
  `classifyModel` says the model supports it (`callLlmTools` — works through the
  OpenAI-compatible, Anthropic, and Google provider adapters in
  `commands/providers.rs`); otherwise the **`@@aka {"call":…}` text protocol**
  (`runTextToolLoop`) so weak local models still get the loop.
- **Step budget (16) + Stop** bound every run; a `no-progress` turn ends
  honestly rather than looping.
- **Chat Only** stays pure chat; **Execute** stays the subprocess-agent path.
- **v1.5 (planned)**: the `fs_write` tools (`str_replace`/`apply_diff`/
  `delete_file`) are already advertised at the Write phase and route to AKA's
  enforced edit commands (checkpoint-before-write + approval + witness); wiring
  Execute+None to that phase is the next pass.

House safety, checkpoints, and the trust split are identical to every other
posture.

---

## 6. Related, already-shipped pieces (do not regress)

- **`--äkä-probe` handshake** (`src-tauri/src/commands/probe.rs`,
  `src/lib/agent-parsers/protocol.ts`): per-session capability probe with an
  in-band `@@aka {"announce":…}` fallback; drives model lock / stream panel /
  contract. Orthogonal to the posture dial — both can be active.
- **Folder-keyed shadow map** (`tools::house_first_winner`): House implementations
  win over a foreign agent's same-named tool unless config opts the agent's in.
