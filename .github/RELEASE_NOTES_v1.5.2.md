## AKA 1.5.2

Two fixes that make the built-in **Execute** loop feel like a real agent run on *any* model: text-protocol tool calls now parse the way models actually write them, and AKA tells you up front when a model will be using that fallback.

### 🔧 Text-protocol tool calls now render and run like agent tool calls
If you ran **None + Execute** with a model that lacks native tool-calling, you may have seen raw `@@aka {"call":…}` JSON dumped into the chat as the "answer" — no tool cards, nothing executed. The tool protocol taught the model to put one marker per line, and the parser held it to that letter. Real models don't comply: they write markers **inline after prose**, **several back-to-back on one line**, and with **multi-line payloads** (raw newlines inside `old_str`/`patch` strings — technically invalid JSON).

The parser is now lenient in exactly those ways:
- Markers are recognized **anywhere** in the response — mid-sentence, concatenated, or spanning lines. The surrounding prose lands in the thinking accordion; the calls render as the same tool cards an agent run produces, and they execute.
- **Unescaped newlines inside JSON strings are repaired** before parsing, so multi-line edit payloads work instead of falling through as text.
- Common argument-name slips are mapped to the schema (`old`/`new` → `old_str`/`new_str`, `pattern` → `query`, `file` → `path`, `cmd` → `command`) — the canonical name always wins when both are present.
- Anything that still isn't a valid call stays visible as prose. Nothing is silently swallowed.

The prompt still teaches the strict one-per-line form (best for small models); AKA is simply strict in what it asks for and generous in what it accepts.

### 💡 A gentle nudge when your model uses the text fallback
When you run **None + Execute**, AKA drives your model through its own tool loop. Models that advertise **native tool-calling** get the clean native path; models that don't get a **text-based protocol** instead. The text path works, but it's measurably less reliable for multi-step edits and shell commands — it's the path most prone to the occasional empty step that 1.5.1 started retrying.

Now, when you pick **None + Execute** with a model that lacks native tool-calling, a subtle line appears above the composer noting that *your selected model* falls back to the text protocol and that a tool-calling model tends to run the loop more steadily.

In keeping with AKA's whole philosophy, the nudge **states a fact and prescribes nothing**:
- It names only the model *you* chose — never a specific replacement. AKA doesn't pick models for you.
- It's purely informational. It never blocks a run, never changes your selection.
- One dismiss silences it for good (remembered across launches).

Neither change adds a gate — the nudge is informational only, and the parser change only makes more of your model's output usable.

---

### ⬇️ Install
- **macOS** (Apple Silicon) → `AKA_1.5.2_aarch64.dmg`
- **Windows** → `AKA_1.5.2_x64-setup.exe`
- **Linux** → `AKA_1.5.2_amd64.AppImage` (portable) · `AKA_1.5.2_amd64.deb` (Debian/Ubuntu) · `AKA-1.5.2-1.x86_64.rpm` (Fedora/RHEL)
