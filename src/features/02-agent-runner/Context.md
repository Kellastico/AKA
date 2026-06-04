# agent-runner

## Status
Generic Rust runner spawns any agent binary in the active project root **inside a
real pseudo-terminal** (`portable_pty`), streams its output as `agent://output`
events, and emits `agent://done` with the exit code. Interactive prompts are
detected generically and surfaced as `agent://question` (answered via
`answer_agent`). Full lifecycle: stop (`stop_agent`), pause/resume
(`pause_agent`/`resume_agent`, SIGSTOP/SIGCONT), and restart (frontend:
roll back to the pre-run checkpoint, then re-run). Every run is bracketed by git
**checkpoints** (feature: `commands::checkpoints`) so anything the agent does is
reversible.

## How it works
- **No built-in agent catalog.** AKA ships and recommends no agent. Every agent
  is user-registered (name + bin + args + llmOwnership) in the user-level
  registry (`src/stores/use-custom-agents-store.ts`), persisted to
  `aka-custom-agents.json`.
- `run_agent(task, project_path)` is the single entry point. It loads the
  project's `.äkä/config.json`, takes the saved `agent` block verbatim, and
  substitutes only `{model}` / `{base_url}` / `{task}` in its args. The runner
  **never inspects which agent it is** or rewrites the model — any provider
  prefix a given agent needs (`openai/…`, `ollama/…`) lives in the user's own
  args or model string. Identical treatment for every agent.
- **Wrapper / env contract.** Before spawning, the runner exports a fixed env
  block to every agent identically: `AKA_MODEL`, `AKA_BASE_URL`, `AKA_API_KEY`,
  `AKA_PROJECT_DIR`, `AKA_TASK`, `AKA_TASK_FILE` (a temp file holding the
  prompt), plus the de-facto `OPENAI_BASE_URL` / `OPENAI_API_BASE` /
  `OPENAI_API_KEY`. An env-aware agent or a thin wrapper script can read these
  instead of using argv placeholders — this is the "plug-and-play any agent"
  path (`src/lib/agent-wrapper.ts` generates starter wrappers).
- **Prompt delivery.** The prompt reaches the agent ONLY via the `{task}`
  placeholder (if present in args) or via `AKA_TASK` / `AKA_TASK_FILE`. It is
  never auto-appended as a trailing positional argument — that magic broke
  agents that treat a stray arg as a filename (`Errno 63`).
- **PTY, not pipes.** The agent runs under `native_pty_system().openpty(...)`
  (40×120) so TTY-expecting tools (prompt_toolkit, readline) work. Output is
  ANSI-stripped, line-buffered, and tagged with the `run_id`. A 400ms idle on a
  prompt-shaped trailing line raises `agent://question`; `answer_agent` types the
  reply into the PTY master.
- **Lifecycle.** Runs are keyed by `run_id` (== session id) in
  `RunnerState.runs: HashMap<String, RunHandle>`, where each handle holds the
  killer, the PTY stdin writer, the child `pid`, and a `paused` flag.
  `stop_agent(run_id?)` kills (one run, or all). `pause_agent`/`resume_agent`
  signal the child's **process group** (`kill(-pid, SIGSTOP|SIGCONT)`) so the
  agent and its children freeze together; both emit `agent://state`
  (`running`/`paused`). Unix-only — a no-op returning `false` elsewhere.
- **Checkpoints.** `run_agent` takes a `prerun` snapshot before spawning and a
  `postrun` snapshot after exit (`create_checkpoint_inner`); the frontend adds a
  per-step snapshot after each successful write/run `tool_end`. All are
  best-effort and never block the run. See `commands::checkpoints`.
- `detect_agents(bins)` / `recheck_agents(bins)` run `which <bin>` + `--version`
  concurrently over the **caller-supplied** bins (the user's registered agents)
  and return `{ bin, installed, version }`. There is no list to scan — the
  frontend passes exactly the bins it wants probed. The picker hides agents
  whose bin isn't found and surfaces a `NoAgentsInstalled` banner when none of
  the registered agents resolve.

## Agent-agnostic file & tool activity

The "Agent worked" accordion (`AgentActivityAccordion`) shows what an agent
touched. It is fed by `AgentEvent` (`tool_start`/`tool_end`) → `role:"tool"`
messages → `rollupFiles`. Two layers populate it for **any** agent, not just
ones with a bespoke parser:

- **Layer 1 — disk truth (zero agent cooperation).** After a run, the frontend
  calls `run_file_changes(project_path, run_id)` which diffs the run's `prerun`
  vs `postrun` checkpoints (`git diff --numstat`) and returns `FileChange[]`.
  `use-chat-store` synthesizes a `write` tool row per changed file (deduped
  against rows a parser already emitted), inserted before the answer so they
  join that run's accordion group. Works for every agent because it reads the
  disk, not stdout. Empty in a non-git project. **Only detects writes** —
  reads/searches/commands leave no disk trace.

- **Layer 2 — `@@aka` protocol (opt-in, for reads/searches/commands).** Any
  agent can print sentinel lines and AKA parses them generically (no per-agent
  code). `createProtocolParser` is composed in FRONT of every agent's base
  parser via `composeParsers` in `src/lib/agent-parsers/index.ts`, so the
  protocol works for all agents while native output (SmallCode glyphs, prose)
  still flows. Marker shape:

  ```
  @@aka {"tool":"read","path":"src/App.jsx"}
  @@aka {"tool":"search","name":"grep","preview":"useEffect"}
  @@aka {"tool":"run","name":"bash","preview":"npm test","ok":true,"ms":840}
  @@aka {"tool":"write","path":"src/x.ts","linesAdded":12,"linesRemoved":3}
  ```

  One marker = one complete tool call (paired start+end). For a long-running
  tool, split it: emit `"phase":"start"` then later `"phase":"end"`. `tool` is
  one of read/write/run/search (unknown → run). Malformed markers are dropped.

  **LangChain emitter** — add a callback handler to your agent script so its
  tool calls show up:

  ```python
  import json, sys
  from langchain_core.callbacks import BaseCallbackHandler

  KIND = {"read_file":"read","write_file":"write","grep":"search","bash":"run"}

  class AkaActivity(BaseCallbackHandler):
      def on_tool_start(self, serialized, input_str, **kw):
          name = (serialized or {}).get("name", "tool")
          print("@@aka " + json.dumps({
              "tool": KIND.get(name, "run"), "name": name,
              "preview": str(input_str)[:120], "phase": "start",
          }), flush=True)
      def on_tool_end(self, output, **kw):
          print("@@aka " + json.dumps({"phase": "end", "ok": True}), flush=True)

  # agent.stream({...}, config={"callbacks": [AkaActivity()]})
  ```

## Constraints
- `run_agent` reads a fully resolved agent block from disk — agent name is
  metadata; runtime logic only touches `bin` and `args`.
- `project_path` always comes from the active project's root; never defaults.
- No agent name, bin, or install command is hardcoded anywhere in the runner.

## Open
- Streaming back-pressure / very long logs (unbounded in store).
- Verification step lives in feature 04 — `verifyCmd` is just metadata here.
