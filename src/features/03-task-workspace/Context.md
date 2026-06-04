# task-workspace

## Status
Verification + self-correction loop implemented.

## What this feature owns
- Reading a project's `.äkä/config.json` to discover `verifyCmd` and `maxRetries`.
- Driving the run loop: `run_agent` → `agent://done` → (optional) `run_verify` →
  on failure, `call_llm` → `run_agent` again, up to `maxRetries`.
- All pass/fail decisions are made purely from the verify exit code.
- Surfacing status (`idle | running | verifying | passed | failed`),
  retry counter, and the verify log (collapsed by default, auto-expands on fail).

## Decisions
- The orchestration loop lives entirely on the TS side
  (`use-task-workspace-store.ts`). Rust knows nothing about retries, the LLM,
  or which agent ran.
- `run_verify` is standalone and decoupled from `run_agent` — it accepts only
  `verifyCmd` + `projectPath` and emits `verify://output`.
- `verifyCmd` and `maxRetries` are stored at the **project** level in
  `.äkä/config.json`, not per-agent. Per-agent overrides in `agents.<id>.verifyCmd`
  remain available to the standalone AgentRunner.
- Default `maxRetries` = 3.
- When no `verifyCmd` is set, the task is marked `passed`/`failed` directly from
  the agent's own exit code and verification is skipped.
- Self-correction prompt includes the **last 50 lines** of verify output plus
  the original task. The LLM's reply is fed back into `run_agent` as the new
  task body — same agent config, same project path.

## Open questions
- Should "Max retries reached" auto-open a diff review pane?
- Do we need a `stop_verify` command for cancellation, or is process kill on
  drop sufficient?
