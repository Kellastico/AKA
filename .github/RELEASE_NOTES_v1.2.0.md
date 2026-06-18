## AKA 1.2.0

Bring-your-own tools just got real, AKA now spots the runtimes you actually
have, and garbled escape codes stop eating your text.

### ✨ Added
- **Overridable built-in tools.** AKA now ships a small pantry of built-in
  tools the agent can call through the bundled `aka-tool` CLI — on the agent's
  PATH every run — starting with **`diagnostics`**, which runs your project's
  configured typecheck/lint and hands back structured
  `{file, line, severity, message}`. It's fully agnostic and overridable: your
  agent's own same-named tools always win, and AKA only fills the gaps. Declare
  what an agent already provides, choose **advertise** vs **gap-fill**, and the
  effective set is handed to agents via the `AKA_TOOLS` env var and a generated
  `.äkä/TOOLS.md`. A new chat-bar indicator shows how many tools are advertised
  and how many your agent overrides.
- **Smarter local-runtime detection.** AKA now detects which runtimes are
  *installed* — not just running — by looking for each one's CLI binary or
  macOS app bundle, searching beyond the process PATH (Homebrew, `~/.local/bin`,
  pip-user locations) so a Finder-launched app still finds them. Adds **MLX**
  and **Jan** alongside Ollama, LM Studio, and llama.cpp, and the connection and
  first-run panels now show only the runtimes you actually have — running, or
  installed but stopped — with clear "Connected / Installed but not running"
  hints.

### 🐛 Fixed
- **ANSI codes no longer corrupt your text.** The escape-stripping regex now
  requires a real ESC prefix, so a bare `[0m`-style fragment inside ordinary
  text (like `arr[0m]`) is left alone instead of being silently deleted from the
  model's reply. Fixed in both the agent-output and SmallCode parsers.

### 🔧 Changed
- Removed an unused legacy custom-agent modal — the inline agent panel is the
  only editor.

---

**Install:** download `AKA_1.2.0_aarch64.dmg` (Apple Silicon). This build is
unsigned, so on first launch right-click the app → **Open** (or run
`xattr -dr com.apple.quarantine /Applications/AKA.app`).

**Full changelog:** https://github.com/Kellastico/AKA/blob/main/CHANGELOG.md
**Compare:** https://github.com/Kellastico/AKA/compare/v1.1.0...v1.2.0
