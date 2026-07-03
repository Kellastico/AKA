# _unassigned-prefs

Documentation only — no code lives here. The leading underscore keeps this
folder out of the numbered 01–10 feature roadmap: it catalogs app-level user
preferences that exist and persist but have no assigned feature home.

## What this covers

`src/stores/use-prefs-store.ts` — a small Zustand store persisted via
tauri-plugin-store (`aka-prefs.json`; no localStorage, per project rule).
Three toggles, all defaulting to `false`:

### 1. `suppressSameModelAdvice`
- **What:** permanently dismisses the "reuse your current model" RAM-pressure
  nudge shown when starting a second session with a *different* model.
- **Set from:** the "don't show this again" checkbox in the advice flow —
  `src/components/project-displays/SessionList.tsx` (reads + sets) and
  `SameModelAdviceModal.tsx` (the modal it suppresses).
- **Un-set from:** nowhere. One-way dismissal.

### 2. `suppressDeleteProjectWarning`
- **What:** skips the full-screen delete-project confirmation.
- **Set from:** the "don't show this again" checkbox in
  `src/components/DeleteProjectModal.tsx`, wired through
  `src/components/project-displays/use-project-deletion.tsx` (reads + sets).
- **Un-set from:** nowhere. One-way dismissal — and this one guards a
  destructive action.

### 3. `autoApplyPosture`
- **What:** the one live *behavioral* toggle (not a dismissed modal). When
  on, switching models mid-session drops any explicit posture override so
  the new model's recommended posture applies —
  `src/features/01-llm-provider/use-runtime-store.ts` (~line 712), with the
  session-meta write in `src/stores/use-messages-store.ts`.
- **Set from:** the Harness posture section of
  `src/components/chatbox/AgentPicker.tsx` (reads + sets). Unlike the two
  suppress toggles, this one already has a visible, two-way home.

## The open question

The two `suppress*` toggles are one-way: once a user checks "don't show this
again," there is no in-app way to see or reverse that choice (short of
deleting `aka-prefs.json`). Do they need a visible home later — e.g. a
"restore dismissed warnings" affordance? Per the design decision in
`features/09-settings/Context.md`, the answer should be a control next to an
existing surface, **not** a new general Settings panel. Unresolved; revisit
if a third one-way dismissal appears.

## What this is not

- Not per-project config — that's `.äkä/config.json`
  (`use-project-config-store`), which has its own surfaces.
- Not a feature to build — if these toggles get a home, they move to that
  feature's Context.md and this folder shrinks or disappears.
