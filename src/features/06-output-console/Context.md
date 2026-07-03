# output-console

## Status
**Real and shipped — two components, not one** (both moved here from
`src/components/pane-content/`; `Pane.tsx` renders them for
`pane.type === "console"` / `"output"`):

- [`ConsoleContent.tsx`](./ConsoleContent.tsx) — the interactive project
  console (pane label "Terminal"). Merges four tagged streams —
  `dev` (dev server), `agent` (agent runner), `verify` (verify command),
  `shell` (user commands) — each color-coded with per-source line counts.
  Includes a free-form shell input at the bottom that runs lines via
  `sh -c` in the project sandbox (Rust `shell_run`; one command at a time,
  Up/Down history recall), plus clear-all and a cwd chip.
- [`OutputContent.tsx`](./OutputContent.tsx) — the dev-server streaming log
  (pane label "Output"). Status dot (running / recovering / exited / failed),
  stop + clear controls, and scroll-pinning: auto-follows the tail unless the
  user has scrolled up to read history.

Note: despite the README's original "xterm" framing, neither component uses
Xterm.js — both are plain React log renderers fed by Zustand stores
(`use-dev-server-store`, `use-shell-runner-store`, agent/task stores), which
stream lines from Tauri events.

## Decisions
- Streams live in stores, not components — the console attaches all source
  listeners on mount so activity is captured even before the pane is opened.

## Open questions
- (none yet)
