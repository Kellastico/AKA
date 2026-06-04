<p align="center">
  <img src="AKA-app-logo.png" alt="AKA" width="120" />
</p>

<h1 align="center">AKA</h1>

<p align="center">
  A local-first, task-driven desktop app for LLM-powered coding agents.<br />
  Bring <em>any</em> model and <em>any</em> agent — AKA orchestrates them.
</p>

---

## What AKA is

AKA is a desktop **work-dispatch tool** for coding agents, not a chat app. You
describe a task, pick a model and an agent, launch, then review the diff and
approve or reject. It runs entirely on your machine.

AKA is **fully agnostic**: you bring your own LLM backend (Ollama, MLX, LM
Studio, any OpenAI-compatible endpoint) and your own agent (Aider, OpenCode,
a LangChain script, a custom binary — anything). AKA never bundles a model or
prescribes an agent; every integration is a user-defined record (name, command
or URL, args) treated identically at runtime.

## Core principles

- **Agnostic by construction.** No model, provider, or agent is ever hardcoded.
- **Local-first.** Your code and config never leave your machine; persistence is
  per-project in `.äkä/config.json`.
- **Task-first, not chat-first.** Describe work, launch it, review the diff.
- **Reversible.** Every run is bracketed by git-backed checkpoints, so anything
  an agent does can be rolled back.

## Features

| #  | Feature              | What it does                                                   |
|----|----------------------|----------------------------------------------------------------|
| 1  | LLM Provider Manager | Detect/connect any OpenAI-compatible runtime                   |
| 2  | Agent Runner         | Spawn any agent binary in a PTY; stream output; answer prompts |
| 3  | Task Workspace       | Describe → launch → review                                     |
| 4  | Diff Viewer          | Monaco-based review of what changed                            |
| 5  | File Explorer        | Browse the project sandbox                                     |
| 6  | Streaming Console    | Real-feel xterm output                                         |
| 7  | Task History         | Past runs                                                      |
| 8  | Context Engine       | Assemble context for the agent                                 |
| 9  | Settings             | Per-project config                                             |
| 10 | Plugin System        | Extend AKA                                                     |

### Agent-agnostic activity tracking

AKA shows **which files and tools an agent touched** for any agent:

- **Disk truth (no cooperation):** after each run it diffs the run's git
  checkpoints and lists every file changed, with line counts.
- **`@@aka` protocol (opt-in):** any agent can print sentinel lines
  (`@@aka {"tool":"read","path":"src/App.jsx"}`) and AKA renders reads,
  searches, and commands in the activity panel — one protocol, every agent.

See [`src/features/02-agent-runner/Context.md`](src/features/02-agent-runner/Context.md)
for the protocol and a LangChain emitter snippet.

## Tech stack

| Layer       | Choice                |
|-------------|-----------------------|
| Shell       | Tauri v2 (Rust)       |
| Frontend    | React 18 + TypeScript |
| Bundler     | Vite                  |
| State       | Zustand               |
| Editor/Diff | Monaco                |
| Terminal    | Xterm.js              |
| Styling     | Tailwind CSS v4       |

## Getting started

### Prerequisites
- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable) + the Tauri v2 prerequisites for your OS
- An LLM runtime (e.g. [Ollama](https://ollama.com)) and an agent of your choice

### Develop
```bash
npm install
npm run tauri dev      # hot-reloading desktop app
```

### Build a release bundle
```bash
npm run tauri build    # produces the .app and .dmg (macOS) under
                       # src-tauri/target/release/bundle/
```

### Test
```bash
npm test               # frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust
```

## Project layout

```
src/                        React + TypeScript frontend
  features/<NN-feature>/    one folder per feature, each with a Context.md
  lib/tauri/commands.ts     the single IPC surface (all invoke() calls)
  stores/                   cross-feature Zustand stores
src-tauri/src/              Rust backend
  commands/                 one file per feature domain
```

Conventions live in [`CLAUDE.md`](CLAUDE.md).

## License

[Apache 2.0](LICENSE) © Kelly Ikemenogo
