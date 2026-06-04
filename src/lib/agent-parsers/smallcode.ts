import type { AgentEvent, AgentParser, ToolKind } from "./types";
import { isNoise } from "./noise";

/**
 * Parser for SmallCode's stdout. The format is defined verbatim in
 * SmallCode's `bin/tui.js` — see the `toolStart`, `toolSuccess`,
 * `toolEdited`, `toolCreated`, `toolUpdated`, `renderDiff`, and
 * `turnSummary` helpers there. Matching ANSI escapes are stripped first
 * so we can match on plain text.
 *
 * Recognised line shapes:
 *   ⚙ <name>                             (tool start — cyan gear)
 *   ✓ <msg> <ms>ms                       (tool ok)
 *   ✗ <msg>                              (tool fail)
 *   ✓ Edited <path>:<line> <ms>ms        (patch success — also tool_end)
 *   ✓ Created <path> (<n> lines) <ms>ms  (write success — also tool_end)
 *   ✓ Updated <path> (<n> lines) <ms>ms  (overwrite success — also tool_end)
 *   $ <cmd> <ms>ms                       (bash success — also tool_end)
 *   ┌─ <path>:<line>                     (diff block start)
 *   │ - <line>                           (diff old)
 *   │ + <line>                           (diff new)
 *   │ ... (N more)                       (diff truncation marker)
 *   └─                                   (diff block end)
 *   ─── <N> tool calls this turn ───     (turn summary — stripped)
 *
 * Anything else is forwarded as a text event so the model's natural-
 * language reply still reaches the assistant message body.
 */

// Matches both proper ANSI SGR sequences (ESC `[` … `m`) and the malformed
// form that shows up when the ESC byte is mis-encoded by an intermediate
// layer and reaches us as a literal Unicode replacement char (`◇` / `□`
// / `�`) followed by the bracket sequence. Stripping both flavours
// keeps the rendered prose clean even when SmallCode's coloured output
// has been mangled in transit.
const ANSI_RE = /(?:\x1b|[�◇□])?\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

const TOOL_START_RE = /^\s*⚙\s+(\S+)/;
// "Edited" is amber-yellow in SmallCode; the rest are green ✓. Match either.
const EDITED_RE = /^\s*[✓✗]\s+Edited\s+(\S+?):(\d+)\s+(\d+)ms\s*$/;
const CREATED_RE = /^\s*[✓✗]\s+Created\s+(\S+)\s+\((\d+)\s+lines?\)\s+(\d+)ms\s*$/;
const UPDATED_RE = /^\s*[✓✗]\s+Updated\s+(\S+)\s+\((\d+)\s+lines?\)\s+(\d+)ms\s*$/;
const SUCCESS_RE = /^\s*✓\s+(.+?)\s+(\d+)ms\s*$/;
// Subagent-execution success: "✓ <Action> <path> <ms>ms" (e.g. "✓ Read src/App.tsx 0ms").
// Action is a capitalised verb, path is the next non-whitespace token.
// Used to surface the file path for read-only ops that don't go through the
// Edited / Created / Updated specialised regexes.
const ACTION_PATH_RE =
  /^\s*([A-Z][a-z]+(?:ed)?)\s+([^\s][^\s]*?)\s*$/;
const ERROR_RE = /^\s*✗\s+(.+?)\s*$/;
const BASH_RE = /^\s*\$\s+(.+?)\s+(\d+)ms\s*$/;
const DIFF_OPEN_RE = /^\s*┌─\s+(\S+?):(\d+)\s*$/;
const DIFF_LINE_RE = /^\s*│\s?([-+ ])\s?(.*)$/;
const DIFF_TRUNC_RE = /^\s*│\s+\.\.\.\s+\((\d+)\s+more\)/;
const DIFF_CLOSE_RE = /^\s*└─/;
const TURN_SUMMARY_RE = /^\s*───\s+\d+\s+tool calls? this turn\s+───\s*$/;

// Map SmallCode's tool names → AKA's broad ToolKind taxonomy used for
// colour-coding. Anything we don't know about gets "run" (purple-ish
// "generic action") as a safe default.
const KIND_BY_NAME: Record<string, ToolKind> = {
  read_file: "read",
  read_and_patch: "write",
  list_files: "search",
  grep: "search",
  search: "search",
  smallcode_patch: "write",
  patch: "write",
  write_file: "write",
  create_file: "write",
  edit_file: "write",
  run_command: "run",
  bash: "run",
  shell: "run",
  exec: "run",
};

const kindOf = (toolName: string): ToolKind =>
  KIND_BY_NAME[toolName.toLowerCase()] ?? "run";

export function createSmallCodeParser(): AgentParser {
  // `pendingTool` is set when we've seen ⚙ <name> but not yet the
  // matching ✓/✗ — we hold the tool name so we can label the close
  // event correctly even if the start line ran together with other
  // output.
  let pendingTool: string | null = null;
  // Most recent non-empty text line observed while a tool is pending.
  // SmallCode tends to print the failure cause as a plain line between
  // the ⚙ start and the next event (`/bin/sh: rg: command not found`),
  // and sometimes never emits a matching ✗. When we auto-close a tool
  // we surface this buffered text as the preview so the user can see
  // why each row is red instead of staring at a wall of mystery
  // failures.
  let pendingPreview: string | null = null;
  // While inside a ┌─ … └─ block we accumulate hunk lines so we can
  // surface +/- counts as a preview. Lines INSIDE the block don't
  // become text events.
  let inDiff = false;
  let diffAdds = 0;
  let diffRems = 0;

  const handle = (raw: string): AgentEvent[] => {
    const line = stripAnsi(raw);

    // Strip the "─── N tool calls this turn ───" footer entirely.
    if (TURN_SUMMARY_RE.test(line)) return [];

    // Diff block handling — line membership is positional, not content.
    if (DIFF_OPEN_RE.test(line)) {
      inDiff = true;
      diffAdds = 0;
      diffRems = 0;
      return [];
    }
    if (inDiff) {
      if (DIFF_CLOSE_RE.test(line)) {
        inDiff = false;
        // The diff block doesn't have its own end-event — the
        // following "✓ Edited <path>:<line> <ms>ms" line will close
        // the tool. We just stop swallowing lines.
        return [];
      }
      const truncM = line.match(DIFF_TRUNC_RE);
      if (truncM) return [];
      const hunkM = line.match(DIFF_LINE_RE);
      if (hunkM) {
        if (hunkM[1] === "+") diffAdds++;
        else if (hunkM[1] === "-") diffRems++;
        return [];
      }
      // Any other line inside the block — drop it (shouldn't happen
      // in practice but stays robust).
      return [];
    }

    // Specialised success lines that also imply tool_end with rich
    // metadata. We check these BEFORE the generic SUCCESS_RE so the
    // path/line info isn't discarded.
    const editedM = line.match(EDITED_RE);
    if (editedM) {
      const elapsed = parseInt(editedM[3], 10);
      const ev: AgentEvent = {
        type: "tool_end",
        ok: true,
        elapsedMs: elapsed,
        path: editedM[1],
        preview: `Edited ${editedM[1]}:${editedM[2]}`,
        linesAdded: diffAdds || undefined,
        linesRemoved: diffRems || undefined,
      };
      pendingTool = null;
      diffAdds = 0;
      diffRems = 0;
      return [ev];
    }

    const createdM = line.match(CREATED_RE);
    if (createdM) {
      const ev: AgentEvent = {
        type: "tool_end",
        ok: true,
        elapsedMs: parseInt(createdM[3], 10),
        path: createdM[1],
        preview: `Created · ${createdM[2]} lines`,
        linesAdded: parseInt(createdM[2], 10),
      };
      pendingTool = null;
      return [ev];
    }

    const updatedM = line.match(UPDATED_RE);
    if (updatedM) {
      const ev: AgentEvent = {
        type: "tool_end",
        ok: true,
        elapsedMs: parseInt(updatedM[3], 10),
        path: updatedM[1],
        preview: `Updated · ${updatedM[2]} lines`,
      };
      pendingTool = null;
      return [ev];
    }

    // Bash one-liner: $ <cmd> <ms>ms — fold into a single start+end so
    // the user sees it as one row.
    const bashM = line.match(BASH_RE);
    if (bashM) {
      const cmd = bashM[1];
      const elapsed = parseInt(bashM[2], 10);
      pendingTool = null;
      return [
        { type: "tool_start", name: "bash", kind: "run" },
        {
          type: "tool_end",
          ok: true,
          elapsedMs: elapsed,
          preview: cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd,
        },
      ];
    }

    // Tool start. Only emit if we're not already inside one — some
    // models double-print the gear, we ignore the second.
    const startM = line.match(TOOL_START_RE);
    if (startM) {
      const name = startM[1];
      const events: AgentEvent[] = [];
      if (pendingTool) {
        // Previous tool never closed cleanly — close it as failed so
        // the UI doesn't show a spinner forever. Carry the most recent
        // text we saw as the preview, otherwise the row would be
        // contextless red.
        events.push({
          type: "tool_end",
          ok: false,
          preview: pendingPreview ?? undefined,
        });
      }
      pendingTool = name;
      pendingPreview = null;
      events.push({ type: "tool_start", name, kind: kindOf(name) });
      return events;
    }

    // Generic ✓ <msg> <ms>ms — close current tool with the msg as
    // preview. Only acts as tool_end when there's a pending tool.
    const sucM = line.match(SUCCESS_RE);
    if (sucM && pendingTool) {
      pendingTool = null;
      pendingPreview = null;
      // Subagent-execution emits `<Action> <path>` in the success message
      // (e.g. "Read src/App.tsx"). Promote the path to `path` so the row
      // shows the file it touched, not just the action verb.
      const inner = sucM[1];
      const actionPathM = inner.match(ACTION_PATH_RE);
      if (actionPathM && actionPathM[2].includes(".")) {
        return [
          {
            type: "tool_end",
            ok: true,
            elapsedMs: parseInt(sucM[2], 10),
            preview: inner,
            path: actionPathM[2],
          },
        ];
      }
      return [
        {
          type: "tool_end",
          ok: true,
          elapsedMs: parseInt(sucM[2], 10),
          preview: inner,
        },
      ];
    }

    const errM = line.match(ERROR_RE);
    if (errM && pendingTool) {
      pendingTool = null;
      pendingPreview = null;
      return [{ type: "tool_end", ok: false, preview: errM[1] }];
    }

    // Drop generic log/stack noise so it doesn't pile up in the body.
    if (isNoise(line)) return [];

    // Unrecognised → natural language text from the model's reply.
    // Use the ANSI-stripped form so colour codes don't bleed into the
    // assistant message body. While a tool is pending, also remember
    // the most recent non-empty line so it can serve as the preview
    // if the tool auto-closes without a matching ✓/✗.
    const trimmed = line.trim();
    if (pendingTool && trimmed.length > 0) {
      pendingPreview = trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed;
    }
    return [{ type: "text", text: line }];
  };

  return {
    feed: handle,
    flush: () => {
      const out: AgentEvent[] = [];
      if (pendingTool) {
        // Stream ended with a tool still in-flight → mark it failed,
        // and surface the most recent line we saw as the preview.
        out.push({
          type: "tool_end",
          ok: false,
          preview: pendingPreview ?? undefined,
        });
        pendingTool = null;
        pendingPreview = null;
      }
      if (inDiff) {
        inDiff = false;
      }
      return out;
    },
  };
}
