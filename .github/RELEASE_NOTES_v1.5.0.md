## AKA 1.5.0

The release where **the model doesn't just plan — it builds**. Pick **None** in the Agent picker + **Execute** mode, and AKA itself drives your model through the full tool loop: read, search, **edit files**, and **run shell commands** — every mutation checkpointed, every risky step gated by an approval policy *you* choose. v1.4.2 gave the built-in loop eyes; 1.5 gives it hands.

### ✨ New — Execute with no agent at all
**None + Execute** is now a real, runnable combination. AKA drives the model end-to-end:

- **File edits** (`str_replace`, `apply_diff`, `delete_file`) run through AKA's enforced edit commands — project-scoped, checkpoint-before-write, witnessed on the timeline. Nothing writes outside your project; everything is undoable.
- **A new `bash` tool.** The model can run shell commands in your project root — build, test, scaffold, inspect. Commands are time-boxed (120 s default, 10 min max), output-capped, and the working tree is snapshotted before each one, so even a shell command is a step you can roll back.
- **Same model range as Strategize.** Native tool-calling models get the native loop; smaller models get the compact text protocol — same tools, same enforcement, same timeline cards.
- **Restart, Stop, and checkpoint rollback** all work mid-run, exactly like an external-agent run — including "Reject & roll back to before the run".

### ✨ New — approval modes: you pick the leash length
A new picker appears next to the mode pill whenever None + Execute is selected:

- **Ask first** *(default)* — every file edit **and** every shell command pauses on an approval card. Approve, reject, or reply in plain words — a free-text reply becomes guidance the model actually reads.
- **Accept edits** — file edits run automatically (still checkpointed); shell commands still ask.
- **Auto** — nothing asks. Edits and commands run without pausing, checkpointed and undoable throughout.

The choice is saved per project in `.äkä/config.json`, and "remember my answer" auto-approves identical prompts for the rest of the session.

### 🔒 Enforced from the outside, as always
The model never gets a say in its own privileges. The `bash` tool lives in the **deny-by-default `exec` folder**: it isn't even advertised to the model outside Execute, an unapproved command is refused host-side with a visible denial card, and Strategize remains read-only by construction — byte-for-byte the same loop it was in 1.4.2.

### 🧰 Also in this build
- **Agent compiler (experimental).** A spec → IR → artifacts pipeline (`.äkä/compiled`, content-addressed) that pre-compiles orchestration for agents that consume it — handed off via `AKA_COMPILED_MANIFEST`, invisible to agents that don't.
- **Readability pass on the timeline.** Reasoning, tool cards, and answers step up to a consistent, slightly larger type scale.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.5.0_aarch64.dmg`
- **Windows** → `AKA_1.5.0_x64-setup.exe`
- **Linux** → `AKA_1.5.0_amd64.AppImage` (portable) · `AKA_1.5.0_amd64.deb` (Debian/Ubuntu) · `AKA-1.5.0-1.x86_64.rpm` (Fedora/RHEL)
