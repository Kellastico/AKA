# Design: AKA Built-in Agent Loop (the "None" path)

Status: **Proposed** — for review before implementation (#1b).
Scope owner: feature 01 (llm-provider) + 02 (agent-runner) + 08 (context-engine).

---

## 1. Why

Today a user who picks **None** in the Agent picker gets a model that can only
*chat* — `callLlmStream` streams text + `<think>` reasoning and nothing else.
Only an **external agent subprocess** (Aider, SmallCode, etc.) can touch files,
because the tool layer (`aka-tool` shim + catalog) is put on the *agent's* PATH
and AKA parses the agent's stdout into the tool accordions the timeline shows.

The product gap this closes: **a beginner with zero knowledge of Ollama or any
agent should be able to run the built-in runtime, download a model via "Add
Model (via Huggingface)", and have it actually edit their code — with the same
witness transparency an agent gets.** That is the keystone that makes the
built-in runtime a complete, zero-dependency path (ties #1b to #4).

So "None" stops meaning "chat only" and starts meaning **"AKA itself is the
agent"** — AKA drives the model through a tool-use loop.

## 2. Current state (verified)

| Piece | Exists today | Reusable as-is |
|---|---|---|
| Witness UI (tool accordions, flat-chronological) | `RunTimeline.tsx` | ✅ |
| Tool-call protocol | `@@aka {…}` markers → `createProtocolParser()` | ✅ the bridge |
| Tool event → timeline message | `role:"tool"`, `toolKind`, `toolStatus` in messages store | ✅ |
| Tool primitives | Tauri cmds: `read_text_file`, `write_text_file` (+ checkpoints), `list_dir`, diagnostics via `aka-tool` | ✅ |
| Capability/safety model | `tools::capability` folders (`fs_read·fs_write·search·git·network·exec`), `tools::policy`, checkpoints | ✅ |
| **Tool-use loop for a direct model** | — | ❌ **build this** |
| **Function-calling in `llm.rs`** | none (no `tools`/`tool_calls`) | ❌ (we avoid it; see §4) |

## 3. Key decision: protocol, not native function-calling

Local GGUF models support OpenAI-style `tools`/`tool_calls` inconsistently. AKA
already ships a model-agnostic alternative — the **`@@aka` line protocol** —
that the protocol parser converts to `tool_start`/`tool_end` events. We reuse
it verbatim:

- The system prompt teaches the model the protocol + the available tools.
- The model emits one `@@aka {…}` marker per tool call mid-stream.
- AKA's existing `createProtocolParser()` parses the stream → same `AgentEvent`s
  an external agent produces → same timeline messages → **witness for free**.

This means no `llm.rs` function-calling work, no model-specific glue, and the
direct path produces witness events through the *identical* pipeline as agents.

## 4. Architecture — the loop

```
user task
  └─> build system prompt: task envelope (feat 08) + TOOLS manifest + @@aka spec
       └─> callLlmStream(history) ──stream──> protocol parser
              │                                   │
              │                              tool_start/tool_end → timeline messages (witness)
              │                                   │
              └── on tool_start: PAUSE generation, execute the tool ──┐
                                                                      │
                          execute via capability-gated Tauri cmd ◄────┘
                                  │
                          result ─> appended to history as a tool result
                                  │
                          └─> next turn: callLlmStream(history) … repeat
  loop ends when: model emits no tool call (final answer) OR budget hit OR Stop
```

Turn loop (frontend, in `use-chat-store`, a new `runBuiltinAgent` alongside the
agent + direct branches):

1. **Compose prompt** — reuse `buildTaskEnvelope` (feat 08) for objective + scope
   rails + DoD, then append a **tool manifest** (from the catalog) and the short
   `@@aka` protocol spec.
2. **Stream a turn** — `callLlmStream`; feed the stream through
   `composeParsers(protocolParser, …)`. Reasoning renders as today; each
   completed `@@aka` marker becomes a `tool` message (status `running`).
3. **Execute the tool** — map `{tool,name,args}` → an existing Tauri command
   (see §5), enforcing the capability folder. Update the tool message to
   `done`/`failed` with a result summary (same shape the timeline already
   expects).
4. **Append result + loop** — push the tool result into history; start the next
   turn. Stop when a turn finishes with no tool call, a **step budget** is
   reached, or the user presses **Stop**.

## 5. Tool surface → execution mapping

| `@@aka` tool | Capability folder | Executes via | Gating |
|---|---|---|---|
| `read` (file) | `fs_read` | `read_text_file` | scope to project root |
| `search` | `search` | `list_dir` / grep cmd / `aka-tool` | read-only |
| `diagnostics` | `search` | `aka-tool diagnostics` | read-only |
| `write` (file) | `fs_write` | `write_text_file` | **checkpoint first + approval gate** |
| `run` (shell) | `exec` | `shell_run` | **deny-by-default, explicit opt-in** |
| network | `network` | — | out of scope for v1 |

## 6. Safety

- **Reuse `tools::capability` + `tools::policy`** — the same privilege folders
  that gate agents gate the built-in loop. No new policy vocabulary.
- **`fs_write` always checkpoints first** (existing checkpoint system) so every
  model edit is revertable, and is **approval-gated** in the UI before applying.
- **`exec` is deny-by-default** — the loop refuses `run` unless the user opted
  in, identical to agent policy.
- **Step/loop budget** — hard cap on turns per task to prevent runaways
  (mirrors the agent watchdog philosophy: warn, don't silently kill — see
  the slow-agent rule).
- **Stop is always the user's** — Stop aborts the loop between turns and on the
  in-flight stream.

## 7. Witness/timeline integration

Zero new UI. Because the loop emits the **same `AgentEvent`s** an external agent
emits, `RunTimeline` renders reasoning + tool accordions identically:
read/write/run/search icons, the 3+-consecutive-tools accordion collapse, diff
views for writes. The user cannot tell (visually) whether a built-in model or an
external agent produced the run — which is the whole point of #1b.

## 8. Model compatibility & fallback

Risk: a small/weak local model may not reliably emit `@@aka` markers.
Mitigations:
- Few-shot the protocol in the system prompt (1–2 worked examples).
- If a turn produces prose with no marker AND no clear final answer, treat it as
  the final answer (don't loop forever).
- Surface a gentle hint when a model never emits a tool call on a clearly
  action-shaped task ("this model may not support tool use — try a larger model
  or an external agent").

## 9. UX / invocation

- **None + Execute** becomes the trigger (today it's blocked with "switch to
  Chat/Edit"). With the loop, Execute + None = "AKA drives this model."
- Chat Only / Edit with None stay pure passthrough (no loop) — unchanged.
- The existing Execute-mode send-gating for None is replaced by launching the
  loop.

## 10. Phasing (recommended)

1. **Phase 1 — read-only MVP**: `read` + `search` + `diagnostics` only. Proves
   the full loop + witness end-to-end with **zero file-mutation risk**. The
   model can inspect a repo and answer questions; the user sees live accordions.
2. **Phase 2 — writes**: add `write` behind checkpoint + approval gating.
3. **Phase 3 — exec/network**: `run` behind the deny-by-default opt-in; network
   allowlist. Optional.

## 11. Open questions

- Step budget default (e.g. 25 turns?) and how to surface "budget reached."
- Do we want a distinct Agent-picker label/mode for "AKA built-in agent" vs the
  pure-chat "None", or keep one "None" whose behavior depends on mode? (Lean:
  keep "None", behavior = mode.)
- Should the tool manifest shown to the model be the full catalog or a
  curated subset for small models?
- Reuse `aka-tool` shim (spawn per call) vs call Tauri commands directly from
  the loop (no subprocess). Lean: **direct Tauri commands** for read/write/list
  (faster, no PATH dependency); `aka-tool` only for diagnostics.

## 12. Out of scope (v1)

- Native OpenAI function-calling in `llm.rs`.
- Multi-file atomic transactions / planning beyond the per-turn loop.
- MCP tool federation into the built-in loop.
