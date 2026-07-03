# settings

## Status
Not implemented — **and no general Settings panel is planned.** This is a
deliberate design decision, not a gap.

## Decisions
- **Runtime/model/BYOK settings live in the Runtime modal, not here.**
  `features/01-llm-provider/ConnectionPanel.tsx` is the home for
  connection-related configuration: saved runtimes, custom endpoints
  (Base URL + API key via `EndpointForm`), and the per-project network
  egress allowlist (`AllowlistSection`, writing
  `capabilities.network_allowlist`). A separate general-purpose Settings
  surface was explicitly rejected in favor of keeping these controls next
  to the thing they configure.
- **Per-project config stays a user-owned file.** `.äkä/config.json` is the
  source of truth (loaded/saved through `use-project-config-store`); the UI
  edits slices of it in place (mode, agent, verify command, retries, tools
  mode, allowlist) from the surfaces where those slices matter. Advanced
  fields (model tuning: `runtime.system_prompt` / `temperature` / `top_p` /
  `vision`, and `task_template`) are deliberately JSON-only for now — see
  the note in `use-project-config-store.ts`.
- **App-level UI prefs** (`use-prefs-store.ts`: dismissed-modal toggles and
  `autoApplyPosture`) persist via tauri-plugin-store and currently have no
  visible management UI. Catalogued in
  `features/_unassigned-prefs/Context.md`; whether they ever need a visible
  home is an open question there — the answer is still not "build a
  Settings panel" by default.

## Open questions
- (none — if a future control doesn't fit an existing surface, first ask
  which surface it belongs next to, not whether to build a Settings panel.)
