# context-engine

## Status
Implemented (first slice): the **Task Envelope**.

`task-envelope.ts` builds a structured wrapper around the user's raw prompt
before it's handed to an agent in Execute mode — objective (verbatim) + scope
rails + definition of done + attachment manifest. This sharpens
instruction-following on small local models and, for vision models, makes them
actually look at attached images (the manifest names each image path and, on a
vision-capable model, adds an explicit "use this as the visual reference"
instruction).

## Decisions
- Stays agent-agnostic — the envelope is plain prompt *text*, never a
  model/agent-specific instruction.
- The template is per project, persisted as `ProjectConfig.task_template`
  (`null`/absent = use `DEFAULT_TASK_TEMPLATE`). For now it (and the runtime
  tuning fields) are edited at the `.äkä/config.json` level only — no in-app
  UI yet; a tuning UI is planned for later. Most users get the default envelope
  automatically without touching anything.
- Success criteria reuse the project's `agent.verify_cmd` when set, else a
  generic "builds and nothing unrelated changed".
- Vision capability is resolved via `resolveVision` (`src/lib/model-capabilities.ts`)
  so an explicit per-project override beats the id heuristic.
- Consumed by the agent path in `src/stores/use-chat-store.ts` (replaces the old
  bare `text + attachmentContext` concatenation). The materialized attachment
  context (inlined file contents) is appended after the framing, unchanged.

## Open questions
- Repo-structure / recent-edits context injection (a richer envelope section)
  is not built yet — candidate for the next slice.
