import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { useMessagesStore, type ToolKind } from "./use-messages-store";
import { projectContextBlock, runAdaptiveToolLoop } from "../lib/builtin-loop";
import { supportKey, useToolSupportStore } from "./use-tool-support-store";
import { isBuiltinLoopAgent, useAgentsStore } from "./use-agents-store";
import { useAttachmentsStore } from "./use-attachments-store";
import { useProjectConfigStore } from "./use-project-config-store";
import { useProjectsStore } from "./use-projects-store";
import { useTokenCounterStore } from "./use-token-counter-store";
import {
  builtinEndpoint,
  useRuntimeStore,
} from "../features/01-llm-provider/use-runtime-store";
import { useWorkspaceStore } from "./use-workspace-store";
import { useDevServerStore } from "./use-dev-server-store";
import { parserForAgent } from "../lib/agent-parsers";
import {
  abortRuntime,
  applyDiff,
  applyStrReplace,
  asAppError,
  builtinToolDefs,
  callLlm,
  callLlmStream,
  callLlmTools,
  deleteFile,
  executeBuiltinTool,
  listDir,
  readImageBase64,
  readTextFile,
  restartRuntime,
  answerAgent,
  runAgent,
  probeAgentCapabilities,
  stopAgent,
  pauseAgent,
  resumeAgent,
  stopLlmStream,
  createCheckpoint,
  restoreCheckpoint,
  checkpointsAvailable,
  runBuiltinBash,
  runFileChanges,
  type AgentQuestion,
  type AgentStateEvent,
  type AppError,
  type ChatMessage,
  type Checkpoint,
  type CheckpointCreated,
  type ContentPart,
  type ContractMode,
  type AgentPosture,
  type ToolPhase,
  type ToolResult,
} from "../lib/tauri/commands";
import {
  approvalGateFor,
  approvalPrompt,
  needsApproval,
  normalizeToolArgs,
  parseApprovalMode,
  parseToolArgs,
  stringArg,
  type ApprovalMode,
} from "../lib/builtin-approvals";
import { resolveVision } from "../lib/model-capabilities";
import { classifyModel, postureToDial, type Posture } from "../lib/model-posture";
import { buildTaskEnvelope } from "../features/08-context-engine/task-envelope";
import { gateForRun } from "../lib/session-concurrency";

/** True when the active runtime is the built-in (managed) sidecar. */
function builtinRuntimeActive(): boolean {
  const rt = useRuntimeStore.getState();
  return (
    rt.builtinPort != null &&
    rt.active?.baseUrl === builtinEndpoint(rt.builtinPort)
  );
}
import type { Attachment } from "./use-attachments-store";

function asAppErrorSafe(err: unknown): AppError {
  return asAppError(err);
}

/**
 * Finalize a (possibly still-pending) assistant placeholder so it stops
 * rendering the "Thinking" spinner. If the placeholder never received any
 * content (the model was stuck, the user cancelled before the first chunk,
 * or the stream was abandoned), we leave a "[stopped]" marker so the chat
 * history is unambiguous.
 */
function finalizePlaceholder(
  placeholderId: string,
  reason: "stopped" | "abandoned",
  sessionId: string | null,
) {
  // Read the placeholder from its OWNING session (not whatever's on screen)
  // so a run finalizing in the background touches the right history.
  const st = useMessagesStore.getState();
  const list =
    sessionId === st.currentSessionId
      ? st.messages
      : sessionId
        ? st.sessionMessages[sessionId] ?? []
        : st.messages;
  const m = list.find((x) => x.id === placeholderId);
  if (!m) return;
  if (m.pendingSince === undefined && m.content.length > 0) return;
  st.patchMessage(
    placeholderId,
    {
      pendingSince: undefined,
      content: m.content.length > 0 ? m.content : `[${reason}]`,
    },
    sessionId,
  );
}

/**
 * Read every attachment in turn and return a single string that gets
 * appended to the user's prompt before it's sent to the LLM. Text files are
 * inlined as fenced code blocks, folders as their child listing, URLs as a
 * plain reference. Images contribute only a textual anchor here — their actual
 * bytes are carried separately as OpenAI `image_url` content parts, built by
 * the history builder in the Ask/Edit path for vision-capable models.
 *
 * Errors are caught per-attachment so one unreadable file doesn't fail the
 * whole send.
 */
async function materializeAttachments(items: Attachment[]): Promise<string> {
  if (items.length === 0) return "";
  const sections: string[] = [];

  for (const item of items) {
    if (item.kind === "file" && item.path) {
      try {
        const payload = await readTextFile(item.path);
        const lang = item.name.split(".").pop()?.toLowerCase() ?? "";
        sections.push(
          `### File: ${item.name}\n\`\`\`${lang}\n${payload.contents}\n\`\`\``,
        );
      } catch (err) {
        sections.push(
          `### File: ${item.name}\n*(could not read: ${
            err instanceof Error ? err.message : String(err)
          })*`,
        );
      }
    } else if (item.kind === "folder" && item.path) {
      try {
        const entries = await listDir(item.path);
        const tree = entries
          .map((e) => (e.kind === "dir" ? `${e.name}/` : e.name))
          .join("\n");
        sections.push(`### Folder: ${item.name}\n\`\`\`\n${tree}\n\`\`\``);
      } catch (err) {
        sections.push(
          `### Folder: ${item.name}\n*(could not read: ${
            err instanceof Error ? err.message : String(err)
          })*`,
        );
      }
    } else if (item.kind === "url" && item.url) {
      sections.push(`### URL: ${item.url}`);
    } else if (item.kind === "image") {
      // Textual anchor. For Ask/Strategize the actual bytes travel as an
      // `image_url` content part built by the history builder (image attachment
      // is gated to vision-capable models, see AttachButton). For Execute mode
      // the spawned agent makes its own model call, so we also surface the
      // absolute path here — an agent that only reads AKA_TASK can still locate
      // and load the file itself.
      sections.push(
        item.path
          ? `### Image: ${item.name}\nPath: ${item.path}`
          : `### Image: ${item.name}`,
      );
    }
  }

  return "\n\n---\n\nAttached context:\n\n" + sections.join("\n\n");
}

/**
 * Derive a short session title from the user's first prompt. Takes the first
 * line, cuts at ~50 chars on a word boundary, appends an ellipsis if cut.
 */
function summarizeTitle(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim();
  if (!firstLine) return "New session";
  if (firstLine.length <= 50) return firstLine;
  const cut = firstLine.slice(0, 50);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + "…";
}

/**
 * Heuristic mapping of error strings (from `llm://error` events or rejected
 * invokes) onto structured AppError variants. Order matters — the most
 * specific patterns first, generic fallback at the end.
 */
function inferLlmError(raw: string): AppError {
  const m = raw.toLowerCase();

  // Tauri-level "command X not found" — happens when the Rust binary is
  // older than the frontend that's calling it. Not a config issue.
  if (
    (m.includes("command") && m.includes("not found")) ||
    m.includes("not implemented") ||
    m.includes("unknown command")
  ) {
    return { kind: "BackendUnavailable", reason: raw };
  }

  // The backend MessageValidator refused to send (streaming path surfaces it
  // as a plain string) — nothing valid was left after sanitization.
  if (m.includes("no valid user or assistant messages")) {
    return { kind: "InvalidConversation", reason: raw };
  }

  // The endpoint answered with an HTTP error — an API rejection, not
  // connectivity. The streaming path formats these as "HTTP <status>: <provider
  // message>"; surface them as ProviderRejected so the banner can distinguish
  // key / rate-limit / bad-request / provider-5xx from "runtime offline".
  const http = raw.match(/\bHTTP (\d{3})\b:?\s*([\s\S]*)/i);
  if (http) {
    return {
      kind: "ProviderRejected",
      status: Number(http[1]),
      message: (http[2] ?? "").trim(),
    };
  }

  // Network / runtime issues — nothing answered at all.
  if (
    m.includes("connection") ||
    m.includes("connect") ||
    m.includes("offline") ||
    m.includes("dns") ||
    m.includes("timed out") ||
    m.includes("refused")
  ) {
    return { kind: "RuntimeOffline" };
  }

  // Anything else is a generic backend failure — surface the raw string so
  // users see what actually came back instead of a misleading "config
  // corrupted" message.
  return { kind: "BackendUnavailable", reason: raw };
}

// Per-session run generations. Each session has its own counter; a submit or
// stop for that session bumps it, and an in-flight async handler bails the
// moment its session's generation moves on. Keying by session means one
// session's new run (or stop) never invalidates another's — the basis for
// running multiple sessions concurrently.
const sessionGen = new Map<string, number>();
const bumpGen = (sessionId: string): number => {
  const next = (sessionGen.get(sessionId) ?? 0) + 1;
  sessionGen.set(sessionId, next);
  return next;
};
const genOf = (sessionId: string): number => sessionGen.get(sessionId) ?? 0;

// Sessions whose current run was stopped by the user. The agent branch reads
// this to render "[cancelled]" instead of a crash when the killed subprocess
// returns a non-zero exit. Cleared when the run's handler finishes.
const cancelledRuns = new Set<string>();

// Per-session memory of answered prompts: sessionId → (prompt text → answer).
// When the user ticks "auto-approve / remember", a later identical prompt in the
// same session is answered automatically instead of surfacing a card again.
const rememberedAnswers = new Map<string, Map<string, string>>();

/**
 * Pending approval waits for built-in loop runs, keyed by session (== run) id.
 * When the built-in Execute loop pauses on a gated tool call, it parks a
 * resolver here and raises a `pendingQuestion`; `answerQuestion` resolves it
 * (instead of typing into an agent PTY), and `stop()` resolves it with "n" so
 * a cancelled run never leaves the loop hanging on a dead promise.
 */
const builtinApprovalResolvers = new Map<string, (text: string) => void>();

/**
 * Release every module-level resource keyed to a session that's being torn down
 * (deleted), so nothing leaks for the app's lifetime. Call from the session
 * delete path. Resolves any parked approval wait as "n" first so a mid-run
 * delete can't strand the loop's promise, then drops the remembered-answers and
 * cancelled-run bookkeeping. Idempotent.
 */
export function forgetSession(sessionId: string): void {
  builtinApprovalResolvers.get(sessionId)?.("n");
  builtinApprovalResolvers.delete(sessionId);
  rememberedAnswers.delete(sessionId);
  cancelledRuns.delete(sessionId);
  sessionGen.delete(sessionId);
}

/** Absolute path of the project that owns `sessionId` (empty if not found). */
function projectPathForSession(sessionId: string): string {
  const ps = useProjectsStore.getState();
  return ps.projects.find((p) => p.sessions.some((s) => s.id === sessionId))?.path ?? "";
}

// Checkpoint + lifecycle events are global (not per-run): a `checkpoint://created`
// can arrive just as the run ends (the post-run snapshot) and the timeline must
// outlive the run, so routing by runId into the store from one app-level listener
// avoids both the detach race and losing checkpoints when `clearRun()` fires.
let checkpointListenersAttached = false;
async function ensureCheckpointListeners(): Promise<void> {
  if (checkpointListenersAttached) return;
  checkpointListenersAttached = true;
  await listen<CheckpointCreated>("checkpoint://created", (e) => {
    const cp = e.payload;
    useChatStore.setState((st) => {
      const prev = st.checkpointsBySession[cp.runId] ?? [];
      // De-dupe on seq (events are at-least-once) and keep oldest-first order.
      const next = [...prev.filter((c) => c.seq !== cp.seq), cp].sort(
        (a, b) => a.seq - b.seq,
      );
      return {
        checkpointsBySession: { ...st.checkpointsBySession, [cp.runId]: next },
      };
    });
  });
  await listen<AgentStateEvent>("agent://state", (e) => {
    const { runId, state } = e.payload;
    useChatStore.setState((st) =>
      runId in st.runs
        ? { runs: { ...st.runs, [runId]: { ...st.runs[runId], runState: state } } }
        : {},
    );
  });
}

// Models whose chat template prefills the <think> opener (DeepSeek-R1,
// Mellum-Thinking…): their streams start already inside a thinking block and
// only ever emit </think>. Learned the first time a stream produces a close
// tag with no opener, and persisted — so every later run with that model
// routes reasoning to the accordion live, instead of streaming it through the
// message body until the close tag finally arrives (which, in agent mode, can
// be the very end of the run: intermediate LLM calls are cut off mid-thinking
// at each tool call and never emit their close).
const THINK_PROFILE_FILE = "aka-think-profiles.json";
const THINK_PROFILE_KEY = "prefillThinkModels";
const prefillThinkModels = new Set<string>();
void (async () => {
  try {
    const store = await load(THINK_PROFILE_FILE, { defaults: {}, autoSave: false });
    const saved = await store.get<string[]>(THINK_PROFILE_KEY);
    if (Array.isArray(saved)) for (const m of saved) prefillThinkModels.add(m);
  } catch {
    // Outside Tauri (browser dev) — in-memory only
  }
})();

function isPrefillThinkModel(modelId?: string | null): boolean {
  return !!modelId && prefillThinkModels.has(modelId);
}

function markPrefillThinkModel(modelId?: string | null) {
  if (!modelId || prefillThinkModels.has(modelId)) return;
  prefillThinkModels.add(modelId);
  void (async () => {
    try {
      const store = await load(THINK_PROFILE_FILE, { defaults: {}, autoSave: false });
      await store.set(THINK_PROFILE_KEY, [...prefillThinkModels]);
      await store.save();
    } catch {
      // Outside Tauri — in-memory only
    }
  })();
}

// Incremental SSE parser that splits a token stream into "content" and
// "thinking" deltas as <think>…</think> (or <thinking>…</thinking>) blocks
// open and close. Tags split across chunks are buffered until they can be
// matched, so the UI never flashes raw tag fragments.
//
// Orphan close tags: when a close tag arrives with no opener before it
// (prefilled-template models, see above), everything streamed since the last
// close was actually reasoning — the parser folds its own pending content
// into `thinking` and reports `reclaim`: how many chars the caller already
// appended to the message body that must be moved to the thinking accordion.
//
// Speculative starts: for models already known to prefill, the parser starts
// in thinking mode (`speculative: true`) so reasoning is contained live. If
// the stream then ends cleanly without ever seeing a close tag, the
// speculation was wrong — flushThinkParser reports `undoThinking` so the
// caller can move the mis-routed text back to the message body.
type ThinkParser = {
  buffer: string;
  inThink: boolean;
  /** Content chars handed to the caller since the last think-block close. */
  contentSinceClose: number;
  /** inThink was set on faith (known prefill model), not by an actual tag. */
  speculative: boolean;
  /** Any close tag seen this stream — confirms the model really thinks. */
  sawClose: boolean;
  /** Thinking chars handed to the caller since stream start. */
  thinkingEmitted: number;
};
const OPEN_TAGS = ["<thinking>", "<think>"];
const CLOSE_TAGS = ["</thinking>", "</think>"];
const ALL_TAGS = [...OPEN_TAGS, ...CLOSE_TAGS];

function newThinkParser(modelId?: string | null): ThinkParser {
  const prefill = isPrefillThinkModel(modelId);
  return {
    buffer: "",
    inThink: prefill,
    contentSinceClose: 0,
    speculative: prefill,
    sawClose: false,
    thinkingEmitted: 0,
  };
}

function findFirstTag(s: string, tags: string[]): { index: number; len: number } | null {
  let best: { index: number; len: number } | null = null;
  for (const tag of tags) {
    const idx = s.indexOf(tag);
    if (idx === -1) continue;
    if (best === null || idx < best.index) best = { index: idx, len: tag.length };
  }
  return best;
}

function potentialTagAtEnd(s: string, tags: string[]): number {
  const maxLen = Math.max(...tags.map((t) => t.length));
  for (let n = Math.min(maxLen - 1, s.length); n > 0; n--) {
    const tail = s.slice(-n);
    if (tags.some((t) => t.startsWith(tail))) return n;
  }
  return 0;
}

function processThinkChunk(
  state: ThinkParser,
  chunk: string,
): { content: string; thinking: string; reclaim: number; orphan: boolean } {
  state.buffer += chunk;
  let content = "";
  let thinking = "";
  let reclaim = 0;
  let orphan = false;
  while (state.buffer.length > 0) {
    if (state.inThink) {
      const hit = findFirstTag(state.buffer, CLOSE_TAGS);
      if (!hit) {
        const hold = potentialTagAtEnd(state.buffer, CLOSE_TAGS);
        thinking += state.buffer.slice(0, state.buffer.length - hold);
        state.buffer = state.buffer.slice(state.buffer.length - hold);
        break;
      }
      // A speculative thinking block closed by a real tag is the prefilled-
      // template pattern too — the opener never streamed.
      if (state.speculative) orphan = true;
      thinking += state.buffer.slice(0, hit.index);
      state.buffer = state.buffer.slice(hit.index + hit.len);
      state.inThink = false;
      state.contentSinceClose = 0;
      state.speculative = false;
      state.sawClose = true;
    } else {
      const openHit = findFirstTag(state.buffer, OPEN_TAGS);
      const closeHit = findFirstTag(state.buffer, CLOSE_TAGS);
      if (closeHit && (!openHit || closeHit.index < openHit.index)) {
        // Orphan close — opener was prefilled by the model's chat template.
        // Everything since the last close was reasoning: pending content from
        // this call goes straight to thinking, already-appended chars are
        // reported back for the caller to reclaim from the message body.
        orphan = true;
        state.sawClose = true;
        thinking += content + state.buffer.slice(0, closeHit.index);
        reclaim += state.contentSinceClose;
        content = "";
        state.contentSinceClose = 0;
        state.buffer = state.buffer.slice(closeHit.index + closeHit.len);
        continue;
      }
      if (!openHit) {
        // Hold back partial close tags too, so an orphan </think> split
        // across chunks can still be matched on the next call.
        const hold = potentialTagAtEnd(state.buffer, ALL_TAGS);
        content += state.buffer.slice(0, state.buffer.length - hold);
        state.buffer = state.buffer.slice(state.buffer.length - hold);
        break;
      }
      content += state.buffer.slice(0, openHit.index);
      state.buffer = state.buffer.slice(openHit.index + openHit.len);
      state.inThink = true;
    }
  }
  // Drop stray OPEN think tags from reasoning: a prefill-think model starts
  // already inside a think block, so a re-emitted `<think>`/`<thinking>` isn't
  // consumed as a tag and would otherwise render literally in the accordion.
  thinking = thinking.replace(/<think(?:ing)?>/gi, "");
  state.contentSinceClose += content.length;
  state.thinkingEmitted += thinking.length;
  return { content, thinking, reclaim, orphan };
}

/**
 * Drain whatever is still buffered when the stream ends. `cleanExit` should
 * be true only for a normal end-of-stream (not a stop or crash): on a clean
 * exit, a still-unconfirmed speculative parser means the model never actually
 * thought, so `undoThinking` reports how many accordion chars to move back to
 * the message body. On a cancelled run, mid-thinking is the expected state
 * and the routed thinking is kept as-is.
 */
function flushThinkParser(
  state: ThinkParser,
  cleanExit = false,
): { content: string; thinking: string; undoThinking: number } {
  const remaining = state.buffer;
  state.buffer = "";
  if (state.speculative && !state.sawClose && cleanExit) {
    return { content: remaining, thinking: "", undoThinking: state.thinkingEmitted };
  }
  return state.inThink
    ? { content: "", thinking: remaining, undoThinking: 0 }
    : { content: remaining, thinking: "", undoThinking: 0 };
}

/** Route one parsed chunk to the message body / thinking accordion, moving
 *  any body chars reclaimed by an orphan </think> first so the accordion
 *  stays in chronological order. An orphan close also brands the model as
 *  prefilled-template so its future streams start contained. */
function routeThinkChunk(
  placeholderId: string,
  parsed: { content: string; thinking: string; reclaim: number; orphan?: boolean },
  sessionId: string | null,
  modelId?: string | null,
) {
  const store = useMessagesStore.getState();
  if (parsed.orphan) markPrefillThinkModel(modelId);
  if (parsed.reclaim > 0)
    store.reclaimContentAsThinking(placeholderId, parsed.reclaim, sessionId);
  if (parsed.content)
    store.appendToMessage(placeholderId, parsed.content, sessionId);
  if (parsed.thinking)
    store.appendThinkingToMessage(placeholderId, parsed.thinking, sessionId);
}


export type ChatMode = "ask" | "edit" | "agent";

export const CHAT_MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: "ask", label: "Chat Only", hint: "Pure conversation — nothing touches your repo" },
  { id: "edit", label: "Strategize", hint: "Read-only tools — the model explores your project and plans; nothing is changed" },
  { id: "agent", label: "Execute", hint: "Run the task end-to-end — your agent, or AKA's built-in loop (edits + shell) with None" },
];

type ChatState = {
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  /**
   * Restore the mode from the active project's `.äkä/config.json`. Falls
   * back to "agent" for any unrecognized value (older configs, etc.).
   */
  hydrateMode: (mode: string) => void;
  /**
   * Approval policy for the built-in Execute loop (None agent + Execute):
   * "ask" pauses on every file edit and shell command, "acceptEdits" only on
   * shell commands, "auto" never. Persisted per project like `mode`.
   */
  approvalMode: ApprovalMode;
  setApprovalMode: (mode: ApprovalMode) => void;
  hydrateApprovalMode: (mode: string) => void;
  inputText: string;
  setInputText: (t: string) => void;
  /**
   * In-flight runs keyed by the owning session id (which also serves as the run
   * id passed to the backend). A key's presence means that session is running;
   * its value carries the assistant placeholder message id so `stop()` can
   * finalize the bubble, plus the agent's pending interactive question (if it's
   * waiting on the user). Multiple keys = multiple sessions running at once.
   */
  runs: Record<
    string,
    {
      placeholderId: string | null;
      modelId: string | null;
      pendingQuestion?: AgentQuestion | null;
      /** Lifecycle of the live run — flips to "paused" under SIGSTOP. */
      runState?: "running" | "paused";
      /**
       * Set by the stale-agent watchdog to the timestamp of the run's last real
       * activity once it has been silent past the stale threshold; null/absent
       * while it's still moving. Drives the "agent may be stale" banner. We never
       * kill on this — it's a heads-up, not a timeout. Cleared the instant output
       * resumes, so a slow-but-alive run silently recovers and can re-warn if it
       * stalls again later.
       */
      staleSince?: number | null;
    }
  >;
  /**
   * Git checkpoints per session (== run id), oldest first. Kept *outside* `runs`
   * so the timeline survives after a run ends — the user reviews the diff and
   * rolls back post-hoc. Populated live by the global `checkpoint://created`
   * listener; covers pre-run, per-step, post-run, manual, and pre-restore snaps.
   */
  checkpointsBySession: Record<string, Checkpoint[]>;
  /** Whether the session's project is a git repo (checkpoints available). */
  checkpointsAvailableBySession: Record<string, boolean>;
  /** Raw task text of the last agent run per session, for `restart`. */
  lastTaskBySession: Record<string, string>;
  /**
   * Last-measured decode rate (tokens/sec) per session. Keyed by session id so
   * two sessions streaming at once each track their own rate; the entry is left
   * in place after a run ends so the meter can show the final rate.
   */
  tokensPerSecBySession: Record<string, number>;
  /**
   * Set when a send is held pending the user's acknowledgement of the
   * memory-limited concurrency warning (different model alongside a running
   * session on a ≤16 GB machine). Null when there's nothing to warn about.
   * Driven entirely by `submit()` so every entry point — send button AND the
   * Enter key — is gated identically.
   */
  pendingRamWarn: { runningModels: string[]; incomingModelId: string | null } | null;
  /** Dismiss the pending RAM warning without sending. */
  dismissRamWarn: () => void;
  submit: (opts?: { force?: boolean }) => void;
  /** Stop a session's run. Defaults to the active session when no id is given. */
  stop: (sessionId?: string) => void;
  /**
   * Answer the interactive prompt a session's agent is waiting on. For an agent
   * run, types `text` into the agent's PTY; for a built-in loop run paused on a
   * tool approval, resolves the in-process wait. Clears the pending question and
   * (when `remember`) auto-answers later identical prompts in that session.
   * Approve = "y", Reject = "n", or any free-text reply.
   */
  answerQuestion: (sessionId: string, text: string, remember?: boolean) => void;
  /** Suspend a running agent (SIGSTOP). Defaults to the active session. */
  pause: (sessionId?: string) => void;
  /** Resume a paused agent (SIGCONT). Defaults to the active session. */
  resume: (sessionId?: string) => void;
  /**
   * Stop the run, roll the working tree back to its "Before run" baseline, then
   * re-issue the same task. Operates on the active session.
   */
  restart: (sessionId?: string) => void;
  /** Roll the working tree back to a specific checkpoint sha for a session. */
  rollbackTo: (sessionId: string, sha: string) => Promise<void>;
  /** Roll back to the session's most recent "Before run" baseline. */
  rollbackToPrerun: (sessionId?: string) => Promise<void>;
  /** Take an on-demand checkpoint now. Defaults to the active session. */
  manualCheckpoint: (sessionId?: string) => Promise<void>;
};

const KNOWN_MODES: ChatMode[] = ["ask", "edit", "agent"];

/**
 * System prompt for the Strategize (read-only) built-in loop. Honest about the
 * boundary: the model can inspect the project but cannot change it, so its
 * deliverable is understanding + a plan, never a claimed edit.
 */
const STRATEGIZE_SYSTEM = [
  "You are a coding strategist working inside the user's project.",
  "You have READ-ONLY tools: you can read files, list directories, search, and run the project's diagnostics.",
  "You CANNOT write files, run arbitrary commands, or change anything — do not claim to have made changes.",
  "Use the tools to actually look at the code before answering. Ground every claim in what you read.",
  "Deliver: a clear explanation and, when asked for work, a concrete step-by-step plan the user (or an agent) can execute.",
].join("\n");

/**
 * System prompt for the built-in Execute loop (None agent + Execute mode) —
 * full toolset: read/search/diagnostics plus file edits and `bash`. Honest
 * about the approval gate: a tool result saying the user declined is a signal
 * to adapt, not to retry the same call.
 */
const EXECUTE_SYSTEM = [
  "You are a coding agent working inside the user's project.",
  "You have tools to read files, list directories, search, run the project's diagnostics, edit files (str_replace / apply_diff / delete_file), and run shell commands (bash).",
  "Read the relevant code BEFORE editing it. Prefer small, anchored str_replace edits.",
  "Every edit and shell command is checkpointed and may pause for the user's approval. If a result says the user declined, do not repeat the same call — adjust your approach or finish with what you know.",
  "When the task is done, verify it (diagnostics or a quick bash check) and summarize exactly what you changed.",
].join("\n");

export const useChatStore = create<ChatState>((set, get) => ({
  // First-time users land in Ask mode — a real LLM conversation. Agent mode
  // spawns the subprocess agent (Aider, OpenCode, …) and runs autonomously,
  // which is rarely what's wanted on a brand-new session.
  mode: "ask",
  setMode: (mode) => {
    set({ mode });
    void useProjectConfigStore.getState().setMode(mode);
  },
  hydrateMode: (mode) => {
    set({ mode: (KNOWN_MODES as string[]).includes(mode) ? (mode as ChatMode) : "ask" });
  },
  approvalMode: "ask",
  setApprovalMode: (approvalMode) => {
    set({ approvalMode });
    void useProjectConfigStore.getState().setApprovalMode(approvalMode);
  },
  hydrateApprovalMode: (mode) => {
    set({ approvalMode: parseApprovalMode(mode) });
  },
  inputText: "",
  setInputText: (inputText) => set({ inputText }),
  runs: {},
  tokensPerSecBySession: {},
  checkpointsBySession: {},
  checkpointsAvailableBySession: {},
  lastTaskBySession: {},
  pendingRamWarn: null,
  dismissRamWarn: () => set({ pendingRamWarn: null }),
  submit: (opts) => {
    const { inputText, mode } = get();
    // Refuse a second concurrent run *within the same session*; other sessions
    // are free to run. A submit always targets the active (currently viewed)
    // session, which is the one whose messages are live.
    const guardSid = useMessagesStore.getState().currentSessionId ?? "";
    if (get().runs[guardSid]) return;

    // Concurrency gate. On a memory-limited machine, launching a *different*
    // model alongside another running session warns first (non-restrictively).
    // Both the send button and the Enter key funnel through here, so the gate
    // is uniform; `force` (from the warning modal's confirm) skips it.
    if (!opts?.force) {
      const others = Object.entries(get().runs)
        .filter(([id]) => id !== guardSid)
        .map(([sessionId, r]) => ({ sessionId, modelId: r.modelId }));
      const gate = gateForRun({
        totalRamGb: useRuntimeStore.getState().hardware?.totalRamGb ?? null,
        runningSessions: others,
        incomingModelId: useRuntimeStore.getState().selectedModelId,
      });
      if (gate.kind === "warn-ram") {
        set({
          pendingRamWarn: {
            runningModels: gate.runningModels,
            incomingModelId: gate.incomingModelId,
          },
        });
        return;
      }
    }
    // Proceeding — clear any warning that was awaiting acknowledgement.
    if (get().pendingRamWarn) set({ pendingRamWarn: null });
    const text = inputText.trim();
    // Allow an attachment-only send (e.g. an image with no text) — the message
    // isn't empty if there's a chip attached.
    const hasAttachments = useAttachmentsStore.getState().items.length > 0;
    if (text.length === 0 && !hasAttachments) return;

    // Pre-flight: every session needs runtime + model + agent (+ installed
    // agent in agent mode). The SetupChecklist banner above the chatbox tells
    // the user what's missing; we just refuse the submit so they can't burn
    // a turn on a doomed call.
    const rt = useRuntimeStore.getState();
    const ag = useAgentsStore.getState();
    const agent = ag.agents.find((a) => a.id === ag.selectedAgentId);
    if (!rt.active || !rt.healthy || !rt.selectedModelId || !agent) {
      return;
    }
    // The None agent needs no bin — Execute + None routes to the built-in loop
    // below (AKA drives the model with the full phase-gated toolset). An
    // EXTERNAL agent in Execute mode still needs a bin to spawn; refuse that
    // case here (the SetupChecklist explains it) rather than crash the backend.
    if (mode === "agent" && !isBuiltinLoopAgent(agent) && !agent.bin.trim()) {
      return;
    }

    const modelId = rt.selectedModelId ?? "";
    const agentId = ag.selectedAgentId;
    const ps = useProjectsStore.getState();
    const projectPath =
      ps.projects.find((p) => p.id === ps.activeProjectId)?.path ?? "";

    // Each turn starts from the transcript estimate; an agent run then drives the
    // meter live via `@@aka {"event":"context"}` markers. Clearing here means a
    // direct (None/Ask/Edit) turn after an agent run reverts to the estimate
    // rather than showing the agent's stale last reading.
    useTokenCounterStore.getState().clearAgentContext();

    // Auto-name the active session from the first user prompt of that
    // session. Only fires while the title is still the placeholder so users
    // who renamed don't get overwritten.
    const beforeCount = useMessagesStore.getState().messages.length;
    if (beforeCount === 0) {
      const psState = useProjectsStore.getState();
      const sid = psState.activeSessionId;
      const pid = psState.activeProjectId;
      if (sid && pid) {
        const proj = psState.projects.find((p) => p.id === pid);
        const sess = proj?.sessions.find((s) => s.id === sid);
        if (sess && sess.title === "New session") {
          void psState.updateSessionTitle(pid, sid, summarizeTitle(text));
        }
      }
    }

    // Snapshot the current attachments, then clear them so the chips drop
    // off the chatbox once the user hits send. The materialized payload is
    // stored on the message itself and read back when we build the history.
    const attachments = useAttachmentsStore.getState().items;
    useAttachmentsStore.getState().clear();

    // The session that owns this run. Every message this run creates or
    // mutates is bound to `ownerSessionId`, so its output lands in its own
    // session even if the user navigates to a different one mid-run. Captured
    // once, here, before any await can change what's on screen.
    const ownerSessionId = useMessagesStore.getState().currentSessionId;

    // This run is keyed by its owning session id: that key is the generation
    // namespace, the `runs` map key, AND the run id handed to the backend so its
    // events route back to exactly this session. Claim the generation now — a
    // later submit (or stop) for this session bumps it, signalling any still-
    // running handler from this run to bail before it writes.
    const runKey = ownerSessionId ?? "";
    const myGen = bumpGen(runKey);

    const markRunning = () =>
      set((st) => ({
        runs: {
          ...st.runs,
          [runKey]: { placeholderId: null, modelId: modelId || null, runState: "running" },
        },
        // Reset this session's rate at the start of a fresh run so the meter
        // doesn't briefly show the previous run's number before the first tick.
        tokensPerSecBySession: { ...st.tokensPerSecBySession, [runKey]: 0 },
      }));
    const setTps = (rate: number) =>
      set((st) => ({
        tokensPerSecBySession: { ...st.tokensPerSecBySession, [runKey]: rate },
      }));
    // Drop this run from the running set — but only if a newer run for the same
    // session hasn't already claimed the slot.
    const clearRun = () => {
      if (genOf(runKey) !== myGen) return;
      set((st) => {
        if (!(runKey in st.runs)) return {};
        const next = { ...st.runs };
        delete next[runKey];
        return { runs: next };
      });
    };
    const setPlaceholder = (placeholderId: string | null) =>
      set((st) =>
        runKey in st.runs
          ? { runs: { ...st.runs, [runKey]: { ...st.runs[runKey], placeholderId } } }
          : {},
      );
    const clearPlaceholderIf = (placeholderId: string) => {
      if (get().runs[runKey]?.placeholderId === placeholderId) setPlaceholder(null);
    };
    const setPendingQuestion = (q: AgentQuestion | null) =>
      set((st) =>
        runKey in st.runs
          ? { runs: { ...st.runs, [runKey]: { ...st.runs[runKey], pendingQuestion: q } } }
          : {},
      );

    // The owning session's message list — read this (never the live `messages`
    // array) when a handler needs to inspect its own messages, since the user
    // may be viewing a different session by then.
    const ownerMessages = () => {
      const st = useMessagesStore.getState();
      return st.currentSessionId === ownerSessionId
        ? st.messages
        : ownerSessionId
          ? st.sessionMessages[ownerSessionId] ?? []
          : st.messages;
    };

    const userMessageId = useMessagesStore.getState().add(
      {
        role: "user",
        content: text,
        attachments: attachments.map((a) => ({
          kind: a.kind,
          name: a.name,
          // Persist the path for images so the history builder can re-read and
          // re-encode the bytes on later turns (multi-turn vision).
          path: a.kind === "image" ? a.path : undefined,
        })),
      },
      ownerSessionId,
    );

    // Pin the run to the session that launched it so the session list can
    // show a "working" indicator on the right row — even if the user navigates
    // to a different session while it runs.
    set({ inputText: "" });
    markRunning();

    /**
     * Run attachment materialization and patch the user message with the
     * resolved context. Called once at the top of each mode's async IIFE so
     * the LLM/agent sees the attachments and the history builder includes
     * them deterministically.
     */
    const resolveAttachments = async (): Promise<string> => {
      if (attachments.length === 0) return "";
      const ctx = await materializeAttachments(attachments);
      if (!ctx || genOf(runKey) !== myGen) return ctx;
      useMessagesStore
        .getState()
        .patchMessage(userMessageId, { attachmentContext: ctx }, ownerSessionId);
      return ctx;
    };

    // Hard pre-check: every mode needs an active project. Bail with a clear
    // message rather than letting the Rust side return an empty-path
    // SandboxViolation that confuses users.
    if (!projectPath) {
      useMessagesStore.getState().add(
        {
          role: "assistant",
          content:
            "Open a project from the bottom bar first — the agent and the LLM both need a project folder to know where to work.",
          modelId: modelId || undefined,
        },
        ownerSessionId,
      );
      clearRun();
      return;
    }

    if (mode === "agent" && !isBuiltinLoopAgent(agent)) {
      // External agent: spawn the subprocess and live-stream its stdout into a
      // placeholder assistant message so the user sees progress as it happens,
      // not after a long silence. (Execute with the "None" agent falls through
      // to the built-in loop branch instead.) The preflight guaranteed a bin.
      void (async () => {
        const attachmentCtx = await resolveAttachments();
        // Wrap the raw prompt in the Task Envelope (feature 08): objective +
        // scope rails + definition of done + attachment manifest. Sharpens any
        // agent, and — on a vision model — explicitly tells it to look at the
        // attached images instead of just receiving their paths.
        const cfg = useProjectConfigStore.getState().config;
        const task = buildTaskEnvelope({
          task: text,
          template: cfg?.task_template,
          attachments,
          attachmentContext: attachmentCtx,
          verifyCmd: cfg?.agent.verify_cmd,
          visionModel: resolveVision(modelId, cfg?.runtime.vision),
        });

        // Capability probe (Phase 5): on this session's FIRST agent run, ask the
        // agent to describe itself via `--äkä-probe`. A probe-answering agent
        // (Änyä/Enyö) auto-enables the rich treatment — model lock, stream panel,
        // host-driven phase routing — purely from what it advertised; a foreign
        // agent that ignores the flag caches a plain result and self-drives, with
        // no error and no UI penalty. Fire-and-forget so it never delays the run
        // or first paint, and cache per session (never re-probe per task). The
        // in-band `@@aka {"announce":…}` marker remains a mid-stream fallback.
        if (ownerSessionId) {
          const sid = ownerSessionId;
          const meta = useMessagesStore.getState().sessionMeta[sid];
          if (meta?.probe === undefined) {
            void probeAgentCapabilities(projectPath).then((probe) => {
              useMessagesStore.getState().setSessionMeta(sid, { probe });
            });
          }
        }

        // Checkpoints: make sure the global listeners are live, remember this
        // run's task (for `restart`), and probe whether the project is a git
        // repo so the UI can show "checkpoints unavailable" when it isn't.
        void ensureCheckpointListeners();
        set((st) => ({
          lastTaskBySession: { ...st.lastTaskBySession, [runKey]: text },
        }));
        void checkpointsAvailable(projectPath).then((ok) =>
          set((st) => ({
            checkpointsAvailableBySession: {
              ...st.checkpointsAvailableBySession,
              [runKey]: ok,
            },
          })),
        );

        const placeholderId = useMessagesStore.getState().add(
          {
            role: "assistant",
            content: "",
            modelId: modelId || undefined,
            agentId,
            pendingSince: Date.now(),
          },
          ownerSessionId,
        );
        setPlaceholder(placeholderId);

        let unlistenOutput: UnlistenFn | null = null;
        let unlistenQuestion: UnlistenFn | null = null;
        const detach = () => {
          unlistenOutput?.();
          unlistenOutput = null;
          unlistenQuestion?.();
          unlistenQuestion = null;
          setPendingQuestion(null);
          clearPlaceholderIf(placeholderId);
          // Same defensive finalize — if the agent never emitted output
          // (failed to spawn, crashed silently), drop the Thinking timer.
          finalizePlaceholder(placeholderId, "abandoned", ownerSessionId);
          // Close any tool row the parser didn't get to (crash mid-tool, hung
          // process) so "Agent is working" can't spin forever after the run.
          useMessagesStore.getState().closeRunningTools(ownerSessionId);
        };

        // Two-stage parser per line of agent output:
        //
        //   raw line ──▶ agent-specific parser ──▶ events
        //                                          │
        //   • tool_start ─────▶ new "running" ToolMessage
        //   • tool_end   ─────▶ patch last ToolMessage with elapsed/preview
        //   • text       ─────▶ pipe through <think> parser, route to
        //                       message body OR thinking accordion
        //
        // The agent parser knows that agent's output format (SmallCode's
        // ⚙/✓/✗/┌─/└─ glyphs, etc.); the <think> parser handles inline
        // reasoning tags regardless of which agent emitted them.
        const thinkParser = newThinkParser(modelId);
        const eventParser = parserForAgent(agent.bin);
        let currentToolMessageId: string | null = null;
        // Kind of the in-flight tool, captured at tool_start so tool_end can
        // decide whether the step mutated the tree (write/run) and warrants a
        // checkpoint.
        let currentToolKind: string | null = null;

        // Discrete reasoning segments (one per ReAct `Thought`) are inserted
        // BEFORE the answer placeholder so they interleave chronologically with
        // the tool rows — [reasoning₁, tool₁, reasoning₂, tool₂, …, answer] —
        // instead of collapsing into one undifferentiated blob. `currentReasoningId`
        // mirrors `currentToolMessageId`: the segment we're streaming into now.
        let currentReasoningId: string | null = null;
        const openReasoning = (): string => {
          if (currentReasoningId) return currentReasoningId;
          currentReasoningId = useMessagesStore.getState().addBefore(
            placeholderId,
            {
              role: "reasoning",
              content: "",
              agentId: agentId || undefined,
              modelId: modelId || undefined,
              thinkingStartedAt: Date.now(),
            },
            ownerSessionId,
          );
          return currentReasoningId;
        };
        const appendReasoning = (text: string) => {
          useMessagesStore
            .getState()
            .appendThinkingToMessage(openReasoning(), text, ownerSessionId);
        };
        const closeReasoning = () => {
          if (!currentReasoningId) return;
          useMessagesStore
            .getState()
            .patchMessage(
              currentReasoningId,
              { thinkingEndedAt: Date.now() },
              ownerSessionId,
            );
          currentReasoningId = null;
        };

        // Route one parsed <think> chunk. Models with `<think>…</think>` tags get
        // their reasoning interleaved as discrete segments BEFORE the answer —
        // exactly like ReAct `Thought:` rows — so each thought renders above the
        // tools it triggered instead of collapsing into one block under the
        // result. Prefill-think models (DeepSeek-R1, Mellum-Thinking…) rely on
        // the placeholder-based reclaim/undo dance to recover mis-speculated
        // text, so they keep the legacy routing. `reclaim > 0` (an orphan close
        // carrying body chars to recover) also falls back, since that recovery
        // is defined against the placeholder body.
        const interleaveThinking = !isPrefillThinkModel(modelId);
        const routeText = (parsed: {
          content: string;
          thinking: string;
          reclaim: number;
          orphan?: boolean;
        }) => {
          if (!interleaveThinking || parsed.reclaim > 0) {
            routeThinkChunk(placeholderId, parsed, ownerSessionId, modelId);
            return;
          }
          if (parsed.orphan) markPrefillThinkModel(modelId);
          // Thinking first (it precedes the close tag), then answer body — which
          // settles the live reasoning segment so it reads as a finished step.
          if (parsed.thinking) appendReasoning(parsed.thinking);
          if (parsed.content) {
            closeReasoning();
            useMessagesStore
              .getState()
              .appendToMessage(placeholderId, parsed.content, ownerSessionId);
          }
        };

        // Live tokens-per-second tracker for agent mode. We count the
        // characters that flow through text events (same char/4 heuristic as
        // Ask/Edit mode) and update the store every 500 ms.
        let agentCharCount = 0;
        const agentStartedAt = Date.now();
        const agentTpsInterval = setInterval(() => {
          if (genOf(runKey) !== myGen) return;
          const elapsedSec = (Date.now() - agentStartedAt) / 1000;
          if (elapsedSec > 0) {
            setTps(Math.round(agentCharCount / 4 / elapsedSec));
          }
        }, 500);

        // Stale-agent watchdog. Agents stream reasoning/tool events while they
        // work, so a long total silence means *either* a genuinely slow step
        // (local models can take many minutes — especially on images) *or* a
        // wedged process. We can't tell the two apart from the outside, so we no
        // longer kill on silence: after STALE_MS of no movement we warn the user
        // the agent may be stale and keep standing by, leaving the Stop button to
        // them. The warning clears the instant output resumes, so a slow-but-
        // alive run recovers on its own and can re-warn if it stalls again later.
        // Skipped while the agent is legitimately blocked on an interactive
        // question (that's waiting on the user, not stale).
        const AGENT_STALE_MS = 360_000; // 6 min of silence → warn, never kill
        let lastAgentActivityAt = Date.now();
        let staleWarned = false;
        const setStale = (since: number | null) =>
          set((st) =>
            runKey in st.runs
              ? { runs: { ...st.runs, [runKey]: { ...st.runs[runKey], staleSince: since } } }
              : {},
          );
        const clearStale = () => {
          if (!staleWarned) return;
          staleWarned = false;
          setStale(null);
        };
        const agentWatchdog = setInterval(() => {
          if (genOf(runKey) !== myGen) {
            clearInterval(agentWatchdog);
            return;
          }
          if (get().runs[runKey]?.pendingQuestion) {
            lastAgentActivityAt = Date.now();
            clearStale();
            return;
          }
          if (Date.now() - lastAgentActivityAt < AGENT_STALE_MS) return;
          if (staleWarned) return; // one warning per stall — no spam
          staleWarned = true;
          setStale(lastAgentActivityAt);
          useRuntimeStore.getState().pushToast({
            kind: "warning",
            text: "Agent may be stale — no output for 6 min. Standing by; press Stop to cancel.",
          });
        }, 10_000);

        const applyToolEnd = (event: {
          ok: boolean;
          elapsedMs?: number;
          preview?: string;
          path?: string;
          imagePath?: string;
          linesAdded?: number;
          linesRemoved?: number;
        }) => {
          if (!currentToolMessageId) return;
          const store = useMessagesStore.getState();
          const patch: Record<string, unknown> = {
            toolStatus: event.ok ? "done" : "failed",
          };
          if (event.elapsedMs !== undefined) {
            patch.toolElapsedMs = event.elapsedMs;
          } else {
            // Parsers like ReAct don't carry a per-tool `ms` — derive the
            // settled duration from the start clock we stamped at tool_start
            // (host-side arrival timing, the agnostic fallback).
            const started = ownerMessages().find(
              (m) => m.id === currentToolMessageId,
            )?.toolStartedAt;
            if (started !== undefined) patch.toolElapsedMs = Date.now() - started;
          }
          if (event.preview !== undefined) patch.toolPreview = event.preview;
          if (event.path !== undefined) patch.toolPath = event.path;
          if (event.imagePath !== undefined) patch.toolImagePath = event.imagePath;
          if (event.linesAdded !== undefined) patch.linesAdded = event.linesAdded;
          if (event.linesRemoved !== undefined)
            patch.linesRemoved = event.linesRemoved;
          store.patchMessage(currentToolMessageId, patch, ownerSessionId);
          currentToolMessageId = null;

          // Per-step checkpoint: snapshot after a successful write/run so the
          // user can roll back this exact step from the timeline. Ties
          // checkpoints to agent steps using the parser we already have — no new
          // parsing. Fire-and-forget; the backend reserves `seq` atomically and
          // the global listener appends the result. A no-op outside a git repo.
          const kind = currentToolKind;
          currentToolKind = null;
          if (event.ok && projectPath && (kind === "write" || kind === "run")) {
            const file = event.path?.split(/[/\\]/).pop();
            const label =
              kind === "write"
                ? `After edit${file ? ` to ${file}` : ""}`
                : "After command";
            void createCheckpoint(projectPath, runKey, label, "step");
          }
        };

        // True only when runAgent resolves (zero exit). Drives the flush-time
        // speculation undo: a clean exit with no close tag ever seen means the
        // speculatively-contained text was really the answer.
        let agentCleanExit = false;
        try {
          unlistenOutput = await listen<{ runId: string; line: string; stream: string }>(
            "agent://output",
            (e) => {
              // Only this session's run — a concurrent session's output carries
              // a different runId and must not leak into this bubble.
              if (e.payload.runId !== runKey) return;
              if (genOf(runKey) !== myGen) return;
              lastAgentActivityAt = Date.now(); // feed the stale-agent watchdog
              clearStale(); // output resumed → drop any "may be stale" warning
              const store = useMessagesStore.getState();

              const events = eventParser.feed(e.payload.line);
              for (const event of events) {
                if (event.type === "tool_start") {
                  // A tool starting means the agent finished thinking out loud —
                  // settle the open reasoning segment so it reads as a completed
                  // step above this tool. The placeholder keeps `pendingSince`
                  // set so the run reads as "running" until the final answer
                  // streams; the run timeline shows live progress on the rail.
                  closeReasoning();
                  // Insert tool rows BEFORE the final-answer placeholder so the
                  // run timeline renders above the result, not below it. The
                  // placeholder stays last and carries the final answer.
                  const toolId = store.addBefore(
                    placeholderId,
                    {
                      role: "tool",
                      content: "",
                      toolKind: event.kind,
                      toolName: event.name,
                      toolPath: event.path,
                      toolImagePath: event.imagePath,
                      toolInput: event.input,
                      toolStatus: "running",
                      toolStartedAt: Date.now(),
                      agentId: agentId || undefined,
                      modelId: modelId || undefined,
                    },
                    ownerSessionId,
                  );
                  currentToolMessageId = toolId;
                  currentToolKind = event.kind;
                } else if (event.type === "tool_end") {
                  applyToolEnd(event);
                  // The next text belongs to a fresh LLM call — prefilled-
                  // template models re-enter thinking immediately, with no
                  // opener ever streamed. Re-arm so it's contained live.
                  if (!thinkParser.inThink && isPrefillThinkModel(modelId)) {
                    thinkParser.inThink = true;
                    thinkParser.speculative = true;
                  }
                } else if (event.type === "reasoning_start") {
                  // Fresh Thought — settle any prior segment, then open a new
                  // one. The placeholder keeps `pendingSince` (run stays
                  // "running"); the live segment renders on the timeline rail.
                  closeReasoning();
                  openReasoning();
                } else if (event.type === "reasoning_delta") {
                  agentCharCount += event.text.length;
                  appendReasoning(event.text + "\n");
                } else if (event.type === "reasoning_end") {
                  closeReasoning();
                } else if (event.type === "context") {
                  // The agent self-reports its REAL prompt size (which AKA can't
                  // see inside the subprocess) — drive the live context meter
                  // from it instead of the visible-transcript estimate.
                  useTokenCounterStore
                    .getState()
                    .setAgentContext(event.usedTokens, event.contextWindow);
                } else if (event.type === "capabilities") {
                  // In-band capability announcement — the fallback transport.
                  // Cache it for the session exactly as an upfront `--äkä-probe`
                  // answer is cached, but PROBE-FIRST: never override an upfront
                  // answer already in hand. Drives the same capability UI.
                  if (ownerSessionId) {
                    const sid = ownerSessionId;
                    const meta = useMessagesStore.getState().sessionMeta[sid];
                    if (!meta?.probe?.answered) {
                      const cc = event.probe["capability-contract"];
                      const contract: ContractMode =
                        typeof cc === "string" &&
                        cc.trim().toLowerCase() === "v1"
                          ? "v1"
                          : "mcp-baseline";
                      useMessagesStore.getState().setSessionMeta(sid, {
                        probe: {
                          answered: true,
                          contract,
                          capabilities: event.probe,
                        },
                      });
                    }
                  }
                } else if (event.type === "control") {
                  // The agent asked the host to drive a capability. Route dev-
                  // server control to the SAME store the "Start Dev Server"
                  // button uses, so agent- and user-driven control converge on
                  // one server (with URL detection + Preview wiring). Confirm
                  // visibly via a toast.
                  if (event.target === "dev_server") {
                    const dev = useDevServerStore.getState();
                    const action = event.action.toLowerCase();
                    const done =
                      action === "kill" || action === "stop"
                        ? "stopped"
                        : action === "restart"
                          ? "restarted"
                          : "started";
                    void (async () => {
                      try {
                        if (action === "kill" || action === "stop") {
                          await dev.stop();
                        } else if (action === "restart") {
                          await dev.stop();
                          await dev.start(projectPath);
                        } else {
                          await dev.start(projectPath);
                        }
                        useRuntimeStore.getState().pushToast({
                          kind: "info",
                          text: `Agent ${done} the dev server.`,
                        });
                      } catch (err) {
                        useRuntimeStore.getState().pushToast({
                          kind: "error",
                          text: `Dev server ${action} failed: ${
                            err instanceof Error ? err.message : String(err)
                          }`,
                        });
                      }
                    })();
                  }
                } else {
                  // text → count chars for TPS, then route through <think> parser
                  agentCharCount += event.text.length;
                  const parsed = processThinkChunk(
                    thinkParser,
                    event.text + "\n",
                  );
                  if (parsed.content) {
                    // First answer text — drop the Thinking indicator now (we
                    // kept it through the tool phase so it sat below the work).
                    if (
                      ownerMessages().find((m) => m.id === placeholderId)
                        ?.pendingSince !== undefined
                    ) {
                      store.patchMessage(
                        placeholderId,
                        { pendingSince: undefined },
                        ownerSessionId,
                      );
                    }
                  }
                  routeText(parsed);
                }
              }
            },
          );

          // Interactive prompts: when the agent pauses waiting on input, surface
          // an approval card for THIS session (filtered by runId). If the user
          // already chose "remember" for an identical prompt this session, answer
          // it automatically without interrupting them again.
          unlistenQuestion = await listen<AgentQuestion>(
            "agent://question",
            (e) => {
              if (e.payload.runId !== runKey) return;
              if (genOf(runKey) !== myGen) return;
              const remembered = rememberedAnswers.get(runKey)?.get(e.payload.prompt);
              if (remembered !== undefined) {
                void answerAgent(runKey, remembered);
                return;
              }
              setPendingQuestion(e.payload);
            },
          );

          // Make sure this project's config carries the selected agent before
          // the backend reads it from disk. Covers the case where the on-load
          // auto-heal didn't run (startup race) so the file is still blank —
          // without this the run would crash with "agent.bin is not configured".
          if (!useProjectConfigStore.getState().config?.agent.bin.trim()) {
            await useProjectConfigStore
              .getState()
              .setAgent({ name: agent.name, bin: agent.bin, args: agent.args });
          }

          // Drive the run directly (no global agent-runner store) so concurrent
          // sessions don't clobber a single shared status. The runId is this
          // session's key; runAgent resolves on a clean exit and rejects with an
          // AppError (AgentCrash) on a non-zero exit.
          // Forward the live model/runtime as overrides so a just-switched
          // model is honoured even if its config write is still in flight.
          {
            const { selectedModelId, active } = useRuntimeStore.getState();
            // Hand the agent the attached files it can read on its own. AKA
            // can't inject images into the agent's model call (it's a separate
            // process), so it exposes the image paths + full attachment list via
            // env (AKA_IMAGE_PATHS / AKA_ATTACHMENTS). Both empty → no-op.
            const imagePaths = attachments
              .filter((a) => a.kind === "image" && a.path)
              .map((a) => a.path as string);
            const attachmentMeta = attachments.map((a) => ({
              name: a.name,
              kind: a.kind,
              path: a.path,
            }));
            // Capability dial (Task 3): derive this spawned agent's posture from
            // the model classification + the session's chosen posture (or the
            // model's recommendation), and emit it as the AGENT_* env dial. None
            // collapses to the thinnest real harness here — a subprocess agent
            // IS being spawned, so "no harness" isn't an option for it; the dial
            // is a no-op for agents that don't honor it.
            const cap = classifyModel(modelId);
            const overridePosture =
              useMessagesStore.getState().sessionMeta[ownerSessionId ?? ""]
                ?.posture;
            const effectivePosture: Posture = overridePosture ?? cap.recommended;
            const dialPosture: Posture =
              effectivePosture === "none" ? "thin" : effectivePosture;
            const dial = postureToDial(dialPosture, cap.nativeToolCalling);
            const posture: AgentPosture | undefined = dial
              ? {
                  profile: cap.profile,
                  toolcall: dial.toolcall,
                  gating: dial.gating,
                  leash: dial.leash,
                }
              : undefined;

            await runAgent(
              task,
              projectPath,
              runKey,
              selectedModelId ?? undefined,
              active?.baseUrl ?? undefined,
              active?.apiKey ?? null,
              imagePaths,
              attachmentMeta,
              posture,
            );
          }
          agentCleanExit = true;
          if (genOf(runKey) !== myGen) {
            detach();
            return;
          }
          // Clean exit — the streamed log is the message, nothing more to add.
        } catch (err) {
          if (genOf(runKey) !== myGen) {
            detach();
            return;
          }
          // A user stop also kills the process (non-zero exit), so tell the two
          // apart: a stop renders "[cancelled]", a real crash shows the error
          // with its stderr tail.
          if (cancelledRuns.has(runKey)) {
            useMessagesStore
              .getState()
              .appendToMessage(placeholderId, "\n[cancelled]", ownerSessionId);
          } else {
            useMessagesStore
              .getState()
              .attachErrorToMessage(placeholderId, asAppErrorSafe(err), ownerSessionId);
          }
        } finally {
          // Drain the agent parser first — any tool/reasoning still in-flight
          // at process exit gets settled so a row doesn't pulse or a timer
          // tick forever.
          for (const event of eventParser.flush()) {
            if (event.type === "tool_end") applyToolEnd(event);
            else if (event.type === "reasoning_delta") appendReasoning(event.text + "\n");
            else if (event.type === "reasoning_end") closeReasoning();
            else if (event.type === "text") {
              routeText(processThinkChunk(thinkParser, event.text + "\n"));
            }
          }
          // Drain the <think> parser for any half-buffered tail.
          const { content, thinking, undoThinking } = flushThinkParser(
            thinkParser,
            agentCleanExit,
          );
          const store = useMessagesStore.getState();
          // `undoThinking` only fires for speculative prefill models, whose
          // reasoning stayed on the placeholder — so it reclaims from there.
          if (undoThinking > 0)
            store.reclaimThinkingToContent(placeholderId, undoThinking, ownerSessionId);
          if (thinking) {
            // A trailing thought interleaves like the rest for tagged models;
            // prefill models keep it on the placeholder.
            if (interleaveThinking) appendReasoning(thinking);
            else store.appendThinkingToMessage(placeholderId, thinking, ownerSessionId);
          }
          if (content) store.appendToMessage(placeholderId, content, ownerSessionId);
          // Belt-and-braces: settle any reasoning segment still open.
          closeReasoning();
          // If the run is over but the answer placeholder is still "pending"
          // (the agent did all its work through tools and never streamed a prose
          // reply, or the stream died), clear the flag so the run stops pulsing
          // a live "Working…" indicator. A clean exit keeps whatever content
          // exists as-is; a crash/cancel already wrote its marker in `catch`.
          if (
            ownerMessages().find((m) => m.id === placeholderId)?.pendingSince !==
            undefined
          ) {
            store.patchMessage(placeholderId, { pendingSince: undefined }, ownerSessionId);
          }
          // Stop the agent TPS interval + stuck watchdog. Intentionally keep the
          // last measured tokensPerSec value so users can read performance after
          // the run.
          clearInterval(agentTpsInterval);
          clearInterval(agentWatchdog);
          clearStale(); // run settled — never leave a "may be stale" flag behind

          // Agent-agnostic "files touched": diff the run's prerun↔postrun
          // checkpoints and synthesize a tool row per changed file, so the
          // SAME AgentActivityAccordion shows what ANY agent wrote — even one
          // (like LangChain) whose stdout carried no parseable tool events.
          // Inserted before the answer placeholder so the rows join that run's
          // accordion group. Deduped against tool rows the parser already
          // emitted for this run, so rollupFiles never double-counts.
          if (projectPath) {
            try {
              const changes = await runFileChanges(projectPath, runKey);
              if (changes.length > 0) {
                const store = useMessagesStore.getState();
                const msgs = ownerMessages();
                const placeholderIdx = msgs.findIndex((m) => m.id === placeholderId);
                const alreadyReported = new Set<string>();
                for (let i = placeholderIdx - 1; i >= 0 && msgs[i].role === "tool"; i--) {
                  if (msgs[i].toolPath) alreadyReported.add(msgs[i].toolPath as string);
                }
                for (const f of changes) {
                  if (alreadyReported.has(f.path)) continue;
                  store.addBefore(
                    placeholderId,
                    {
                      role: "tool",
                      content: "",
                      toolKind: "write",
                      toolName: "file change",
                      toolPath: f.path,
                      toolStatus: "done",
                      linesAdded: f.linesAdded,
                      linesRemoved: f.linesRemoved,
                    },
                    ownerSessionId,
                  );
                }
              }
            } catch {
              // File accounting is best-effort — never let it break run teardown.
            }
          }

          // Roll any open browser pane forward so the user sees the agent's
          // file changes immediately. The dev server doesn't broadcast HMR
          // events (Python http.server, plain static, etc.), so AKA does
          // the post-run refresh itself.
          useWorkspaceStore.getState().bumpPreviewReload();
          detach();
          cancelledRuns.delete(runKey);
          clearRun();
        }
      })();
      return;
    }

    if ((mode === "edit" || mode === "agent") && isBuiltinLoopAgent(agent)) {
      // The built-in loop — AKA drives the model itself (the "None" agent).
      // Strategize runs the READ-ONLY floor (read/list/search/diagnostics —
      // phase-gated, so no write or exec tool is even advertised). Execute
      // unlocks the full phase: file edits + bash, each routed through AKA's
      // enforced commands and gated by the user's approval mode. Native
      // tool-calling when the model supports it, the @@aka text protocol
      // otherwise. Tool activity renders as the same timeline cards an agent
      // run produces.
      const phase: ToolPhase = mode === "agent" ? "exec" : "readonly";
      const approvalMode: ApprovalMode = get().approvalMode;
      void (async () => {
        const attachmentCtx = await resolveAttachments();
        if (genOf(runKey) !== myGen) return;
        const cfg = useProjectConfigStore.getState().config;
        const task = buildTaskEnvelope({
          task: text,
          template: cfg?.task_template,
          attachments,
          attachmentContext: attachmentCtx,
          verifyCmd: cfg?.agent.verify_cmd,
          visionModel: resolveVision(modelId, cfg?.runtime.vision),
        });

        const placeholderId = useMessagesStore.getState().add(
          {
            role: "assistant",
            content: "",
            modelId: modelId || undefined,
            agentId,
            pendingSince: Date.now(),
          },
          ownerSessionId,
        );
        setPlaceholder(placeholderId);

        // Stop() bumps this session's generation; the wrapper aborts the loop
        // at the next turn/tool boundary when that happens.
        const controller = new AbortController();
        const bailIfStale = () => {
          if (genOf(runKey) !== myGen) controller.abort();
        };

        // Timeline hooks — the same message shapes the agent path emits, so
        // the run timeline renders identically (flat + chronological).
        let currentToolId: string | null = null;
        const store = () => useMessagesStore.getState();
        const kindOf = (name: string): ToolKind =>
          name === "read_file"
            ? "read"
            : name === "diagnostics" || name === "bash"
              ? "run"
              : approvalGateFor(name) === "edit"
                ? "write"
                : "search";
        const hooks = {
          // Keep the context meter honest during the loop: the real prompt
          // (tool results included) is invisible to the transcript estimate,
          // so the loop reports its serialized size before every model turn.
          // contextWindow 0 = fall back to the selected model's known limit.
          onUsage: (estimatedTokens: number) => {
            if (genOf(runKey) !== myGen) return;
            useTokenCounterStore.getState().setAgentContext(estimatedTokens, 0);
          },
          // The model returned an empty turn; the loop is re-asking. Surface it
          // as a reasoning line so a silent local-model hiccup doesn't look like
          // the run froze.
          onEmptyRetry: (attempt: number) => {
            if (genOf(runKey) !== myGen) return;
            store().add(
              {
                role: "reasoning",
                content: "",
                thinkingContent: `The model returned an empty response — retrying (${attempt})…`,
                thinkingStartedAt: Date.now(),
                thinkingEndedAt: Date.now(),
                modelId: modelId || undefined,
                agentId,
              },
              ownerSessionId,
            );
          },
          onReasoning: (textChunk: string) => {
            if (genOf(runKey) !== myGen) return;
            store().add(
              {
                role: "reasoning",
                content: "",
                thinkingContent: textChunk,
                thinkingStartedAt: Date.now(),
                thinkingEndedAt: Date.now(),
                modelId: modelId || undefined,
                agentId,
              },
              ownerSessionId,
            );
          },
          onToolStart: (call: { name: string; argumentsJson: string }) => {
            if (genOf(runKey) !== myGen) return;
            let path: string | undefined;
            try {
              const args = JSON.parse(call.argumentsJson) as {
                path?: string;
                query?: string;
                command?: string;
              };
              path = args.path;
              if (!path && args.query) path = `"${args.query}"`;
              if (!path && args.command) path = args.command;
            } catch {
              /* unparseable args — card still renders by name */
            }
            // First visible activity — drop the Thinking indicator.
            if (
              ownerMessages().find((m) => m.id === placeholderId)?.pendingSince !==
              undefined
            ) {
              store().patchMessage(placeholderId, { pendingSince: undefined }, ownerSessionId);
            }
            currentToolId = store().addBefore(
              placeholderId,
              {
                role: "tool",
                content: "",
                toolKind: kindOf(call.name),
                toolName: call.name,
                toolPath: path,
                toolStatus: "running",
                toolStartedAt: Date.now(),
                agentId,
                modelId: modelId || undefined,
              },
              ownerSessionId,
            );
          },
          onToolEnd: (result: { name: string; ok: boolean; content: string }) => {
            if (genOf(runKey) !== myGen || !currentToolId) return;
            const started = ownerMessages().find((m) => m.id === currentToolId)?.toolStartedAt;
            store().patchMessage(
              currentToolId,
              {
                toolStatus: result.ok ? "done" : "failed",
                toolElapsedMs: started !== undefined ? Date.now() - started : undefined,
                toolPreview: result.content.slice(0, 200),
              },
              ownerSessionId,
            );
            currentToolId = null;
          },
        };

        try {
          const tools = await builtinToolDefs(phase);

          // Transport by EVIDENCE, never by model name (AKA is agnostic):
          // ask the runtime what this model advertises (Ollama self-reports
          // per-model capabilities), fold in anything this session already
          // observed, and otherwise start OPTIMISTIC — try native tool-calling
          // and let the adaptive loop fall back to the text protocol if the
          // endpoint rejects the `tools` parameter.
          const runtimeBaseUrl = useRuntimeStore.getState().active?.baseUrl ?? "";
          try {
            await useToolSupportStore.getState().ensureProbe(runtimeBaseUrl, modelId);
          } catch {
            /* unknown is fine — the adaptive loop probes behaviorally */
          }
          const knownTransport =
            useToolSupportStore.getState().known[supportKey(runtimeBaseUrl, modelId)];
          const startNative = knownTransport !== "text";

          // Execute runs mutate the tree — take the same "Before run" baseline
          // an agent run gets, so Restart / "Reject & roll back" work here too.
          if (phase === "exec") {
            void ensureCheckpointListeners();
            set((st) => ({
              lastTaskBySession: { ...st.lastTaskBySession, [runKey]: text },
            }));
            try {
              const available = await checkpointsAvailable(projectPath);
              set((st) => ({
                checkpointsAvailableBySession: {
                  ...st.checkpointsAvailableBySession,
                  [runKey]: available,
                },
              }));
              if (available) await createCheckpoint(projectPath, runKey, "Before run", "prerun");
            } catch {
              /* checkpoints are best-effort — never block the run */
            }
          }

          // Pause the loop on a gated call until the user answers (or the
          // approval mode auto-approves). Identical prompts remembered via the
          // card's checkbox short-circuit without pausing. `stop()` resolves a
          // parked wait with "n" so cancellation never strands the promise.
          const requestApproval = (prompt: string): Promise<string> =>
            new Promise((resolve) => {
              const remembered = rememberedAnswers.get(runKey)?.get(prompt);
              if (remembered !== undefined) {
                resolve(remembered);
                return;
              }
              builtinApprovalResolvers.set(runKey, (answer) => {
                builtinApprovalResolvers.delete(runKey);
                resolve(answer);
              });
              setPendingQuestion({ runId: runKey, prompt, kind: "confirm" });
            });

          const executeTool = async (
            name: string,
            argumentsJson: string,
          ): Promise<ToolResult> => {
            bailIfStale();
            // Parse ONCE and map the arg-name variants models actually emit
            // (`old`→`old_str`, `pattern`→`query`, …) onto the schema's names,
            // so a capable-but-sloppy model's calls run instead of bouncing
            // with anchor/missing-arg errors. Reused by the approval prompt
            // and every dispatch path below.
            const args = normalizeToolArgs(name, parseToolArgs(argumentsJson));
            const normalizedJson = JSON.stringify(args);
            const s = (k: string) => stringArg(args, k);

            // The read-only floor: exactly the pre-existing Strategize path.
            if (phase === "readonly") {
              return executeBuiltinTool(name, normalizedJson, projectPath, "readonly");
            }

            const gate = approvalGateFor(name);
            if (gate && needsApproval(approvalMode, gate)) {
              const answer = (await requestApproval(approvalPrompt(name, args))).trim();
              bailIfStale();
              if (controller.signal.aborted) return { ok: false, content: "Cancelled." };
              if (!/^y/i.test(answer)) {
                // A free-text reply is guidance, not just a "no" — hand the
                // model the user's words so it can adapt.
                const note = /^n$/i.test(answer) || answer === "" ? "" : ` They said: ${answer}`;
                return {
                  ok: false,
                  content: `The user declined this action.${note} Do not retry the same call — adjust your approach.`,
                };
              }
            }

            // Gated tools run through AKA's enforced commands (scope +
            // checkpoint + approval + witness baked in); everything else goes
            // through the read chokepoint at this phase.
            try {
              switch (name) {
                case "bash":
                  return await runBuiltinBash(
                    projectPath,
                    runKey,
                    s("command"),
                    typeof args.timeout_secs === "number" ? args.timeout_secs : null,
                    true,
                  );
                case "str_replace": {
                  const r = await applyStrReplace(projectPath, runKey, {
                    path: s("path"),
                    oldStr: s("old_str"),
                    newStr: s("new_str"),
                  });
                  return {
                    ok: true,
                    content: `Edited ${s("path")} (+${r.linesAdded}/−${r.linesRemoved} lines).`,
                  };
                }
                case "apply_diff":
                  await applyDiff(s("patch"), projectPath, runKey);
                  return { ok: true, content: "Patch applied." };
                case "delete_file":
                  await deleteFile(projectPath, runKey, s("path"), true);
                  return { ok: true, content: `Deleted ${s("path")}.` };
                default:
                  return await executeBuiltinTool(name, normalizedJson, projectPath, phase);
              }
            } catch (err) {
              // Enforced-command rejections (bad anchor, out of scope, patch
              // failure) come back as model-readable errors, not loop crashes.
              // EditConflict carries `reason`; apply_diff rejects with a plain
              // string; anything else degrades to its JSON form.
              const raw = err as { reason?: string; message?: string } | string | null;
              const content =
                typeof raw === "string"
                  ? raw
                  : raw?.reason ?? raw?.message ?? JSON.stringify(err);
              return { ok: false, content: content || "Tool call failed." };
            }
          };

          // Ground the model in the project BEFORE the first turn: name, root,
          // and a top-level listing (fetched through the same enforced list_dir
          // tool it uses) — otherwise the model starts blind, not knowing which
          // project it's in or what files exist. Best-effort: a listing failure
          // degrades to the identity line, never blocks the run.
          let listing: string | null = null;
          try {
            const rootList = await executeBuiltinTool("list_dir", "{}", projectPath, "readonly");
            if (rootList.ok) listing = rootList.content;
          } catch {
            /* identity line still grounds the model */
          }
          const system = `${phase === "exec" ? EXECUTE_SYSTEM : STRATEGIZE_SYSTEM}\n\n${projectContextBlock(projectPath, listing)}`;
          // Execute runs do real multi-step work (read → edit → verify), so
          // they get a bigger turn budget than a read-only planning pass.
          const maxSteps = phase === "exec" ? 32 : undefined;

          // A 4xx rejection before native ever worked = "this endpoint can't
          // take a tools request" (Ollama answers 400 "does not support tools").
          // Auth and rate-limit rejections are real errors, not capability
          // signals, so they propagate instead of triggering the fallback.
          const isToolsUnsupported = (err: unknown) => {
            const e = err as { kind?: string; status?: number } | null;
            return (
              e?.kind === "ProviderRejected" &&
              typeof e.status === "number" &&
              e.status >= 400 &&
              e.status < 500 &&
              e.status !== 401 &&
              e.status !== 403 &&
              e.status !== 429
            );
          };

          const result = await runAdaptiveToolLoop({
            system,
            task,
            tools,
            startNative,
            modelTurn: async (messages) => {
              bailIfStale();
              return callLlmTools(messages, tools, projectPath, modelId);
            },
            textTurn: async (messages) => {
              bailIfStale();
              return callLlm(messages, projectPath, modelId);
            },
            isToolsUnsupported,
            onTransportFallback: () => {
              // Remember the observation and tell the user — a downgrade
              // mid-run must never look like silence.
              useToolSupportStore.getState().observe(runtimeBaseUrl, modelId, "text");
              if (genOf(runKey) !== myGen) return;
              store().add(
                {
                  role: "reasoning",
                  content: "",
                  thinkingContent:
                    "This runtime rejected native tool-calling for the selected model — switching to AKA's text-based tool protocol…",
                  thinkingStartedAt: Date.now(),
                  thinkingEndedAt: Date.now(),
                  modelId: modelId || undefined,
                  agentId,
                },
                ownerSessionId,
              );
            },
            executeTool,
            hooks,
            maxSteps,
            signal: controller.signal,
          });
          // A run that finished natively is ground truth for this session.
          if (result.transport === "native") {
            useToolSupportStore.getState().observe(runtimeBaseUrl, modelId, "native");
          }

          if (genOf(runKey) !== myGen) return;
          const finalText =
            result.finalText ??
            (result.stopReason === "budget"
              ? "[stopped — step budget reached before the model finished. Try narrowing the task.]"
              : result.stopReason === "aborted"
                ? ""
                : result.stopReason === "empty"
                  ? "[the model kept returning an empty response. This model may be unreliable for tool use — try again, rephrase the task, or pick a different model.]"
                  : "[the model produced no answer]");
          if (finalText) {
            store().patchMessage(
              placeholderId,
              { content: finalText, pendingSince: undefined },
              ownerSessionId,
            );
          }
        } catch (err) {
          if (genOf(runKey) !== myGen) return;
          store().patchMessage(
            placeholderId,
            { error: asAppError(err), pendingSince: undefined },
            ownerSessionId,
          );
        } finally {
          // Never leave an approval wait parked for a run that's over.
          builtinApprovalResolvers.get(runKey)?.("n");
          if (genOf(runKey) === myGen) {
            finalizePlaceholder(placeholderId, "abandoned", ownerSessionId);
            useMessagesStore.getState().closeRunningTools(ownerSessionId);
            clearPlaceholderIf(placeholderId);
            clearRun();
            // Execute runs change files on disk — roll any open preview pane
            // forward, same as the external-agent path.
            if (phase === "exec") useWorkspaceStore.getState().bumpPreviewReload();
          }
        }
      })();
      return;
    }

    // Ask / Edit mode: stream the reply into a placeholder message.
    void (async () => {
      await resolveAttachments();

      // Build history AFTER materialization so the patched attachmentContext
      // makes it into the user turn we just sent. Read from the OWNING session
      // so the history is this conversation's — not whatever the user may have
      // navigated to while attachments materialized.
      //
      // For vision-capable models, any message carrying image attachments is
      // emitted as an OpenAI content-parts array ([text, …image_url]) with the
      // image bytes inlined as base64 `data:` URLs. Text-only models (and
      // messages without images) keep the plain-string content. Building is
      // async because each image is re-read/encoded from disk on demand.
      const multimodal = resolveVision(
        modelId,
        useProjectConfigStore.getState().config?.runtime.vision,
      );
      const history: ChatMessage[] = await Promise.all(
        ownerMessages()
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map(async (m): Promise<ChatMessage> => {
            const role = m.role as "user" | "assistant";
            const text = m.attachmentContext
              ? m.content + m.attachmentContext
              : m.content;

            const imagePaths = multimodal
              ? (m.attachments ?? [])
                  .filter((a) => a.kind === "image" && a.path)
                  .map((a) => a.path as string)
              : [];
            if (imagePaths.length === 0) return { role, content: text };

            // Read + encode each image; drop any that fail so one unreadable
            // file never sinks the whole send.
            const imageParts = (
              await Promise.all(
                imagePaths.map(async (p): Promise<ContentPart | null> => {
                  try {
                    const url = await readImageBase64(p);
                    return url ? { type: "image_url", image_url: { url } } : null;
                  } catch {
                    return null;
                  }
                }),
              )
            ).filter((x): x is ContentPart => x !== null);
            if (imageParts.length === 0) return { role, content: text };

            return {
              role,
              content: [{ type: "text", text }, ...imageParts],
            };
          }),
      );

      const placeholderId = useMessagesStore.getState().add(
        {
          role: "assistant",
          content: "",
          modelId: modelId || undefined,
          agentId,
          pendingSince: Date.now(),
        },
        ownerSessionId,
      );
      setPlaceholder(placeholderId);

      let unlistenChunk: UnlistenFn | null = null;
      let unlistenDone: UnlistenFn | null = null;
      let unlistenError: UnlistenFn | null = null;

      const parser = newThinkParser(modelId);

      // Live tokens-per-second tracker. We don't have a real tokenizer in
      // the WebView, so we approximate with characters/4 (the same heuristic
      // used by the Rust `count_tokens` command) and recompute once a second.
      let charCount = 0;
      const startedAt = Date.now();
      const tpsInterval = setInterval(() => {
        if (genOf(runKey) !== myGen) return;
        const elapsedSec = (Date.now() - startedAt) / 1000;
        if (elapsedSec <= 0) return;
        setTps(Math.round(charCount / 4 / elapsedSec));
      }, 500);

      // Typewriter buffer: SSE chunks arrive in bursts (the LLM emits many
      // tokens between flushes), which looks chunky. We accumulate incoming
      // text in `pendingDisplay` and drain it onto the message at a steady
      // rate so users see characters flow live instead of jumping in blocks.
      let pendingDisplay = "";
      let streamEnded = false;
      const TYPE_INTERVAL_MS = 16; // ~60 fps
      const MAX_CHARS_PER_TICK = 6; // ~360 chars/sec — fast but smooth

      const flushTypewriter = () => {
        if (pendingDisplay.length === 0) return;
        // When the stream has ended we drain everything that's left in one
        // go so we never sit waiting at the end of a response.
        const take = streamEnded
          ? pendingDisplay.length
          : Math.min(MAX_CHARS_PER_TICK, pendingDisplay.length);
        const slice = pendingDisplay.slice(0, take);
        pendingDisplay = pendingDisplay.slice(take);
        const parsed = processThinkChunk(parser, slice);
        const store = useMessagesStore.getState();
        const target = ownerMessages().find((m) => m.id === placeholderId);
        if (target?.pendingSince !== undefined) {
          store.patchMessage(
            placeholderId,
            { pendingSince: undefined },
            ownerSessionId,
          );
        }
        routeThinkChunk(placeholderId, parsed, ownerSessionId, modelId);
      };

      const typewriterInterval = setInterval(() => {
        if (genOf(runKey) !== myGen) return;
        flushTypewriter();
      }, TYPE_INTERVAL_MS);

      // Stuck-runtime watchdog. If the built-in runtime goes silent mid-
      // generation for too long, abort it; if it's still silent shortly
      // after, restart it and tell the user. Only the managed runtime is
      // recoverable this way — external servers are the user's to manage.
      const STUCK_MS = 30_000;
      const POST_ABORT_GRACE_MS = 2_000;
      let lastChunkAt = Date.now();
      let recovering = false;
      const watchdog = setInterval(() => {
        if (genOf(runKey) !== myGen || recovering) return;
        if (!builtinRuntimeActive()) return;
        if (Date.now() - lastChunkAt < STUCK_MS) return;
        recovering = true;
        const silentSince = lastChunkAt;
        void (async () => {
          await abortRuntime();
          await new Promise((r) => setTimeout(r, POST_ABORT_GRACE_MS));
          if (genOf(runKey) !== myGen) return;
          // Still nothing after the grace period → restart and notify.
          if (lastChunkAt === silentSince) {
            await restartRuntime();
            useRuntimeStore.getState().pushToast({
              kind: "info",
              text: "Runtime was unresponsive and has been restarted.",
            });
          }
          recovering = false;
        })();
      }, 5_000);

      const cleanup = () => {
        unlistenChunk?.();
        unlistenDone?.();
        unlistenError?.();
        unlistenChunk = unlistenDone = unlistenError = null;
        clearInterval(watchdog);
        clearInterval(tpsInterval);
        // Drain anything left in the typewriter buffer before stopping the
        // interval so the user always sees the full response.
        streamEnded = true;
        while (pendingDisplay.length > 0) flushTypewriter();
        clearInterval(typewriterInterval);
        // Clear the placeholder pointer so stop() / a subsequent submit
        // doesn't try to finalize an already-completed message.
        clearPlaceholderIf(placeholderId);
        // Defensive: if the stream ended without producing any content
        // (model crashed, empty response, network hung), finalize the
        // placeholder so its "Thinking…" timer stops ticking. Successful
        // streams already cleared pendingSince via the chunk handler — this
        // is a no-op for those.
        finalizePlaceholder(placeholderId, "abandoned", ownerSessionId);
        // Intentionally leave this session's tokensPerSecBySession entry in
        // place — the meter should keep showing the last measured rate so users
        // can see how the model performed after the stream completes.
      };

      try {
        unlistenChunk = await listen<{
          runId: string;
          text: string;
          thinking?: string;
        }>(
          "llm://chunk",
          (e) => {
            // Ignore other sessions' streams — they carry a different runId.
            if (e.payload.runId !== runKey) return;
            if (genOf(runKey) !== myGen) return;
            lastChunkAt = Date.now(); // feed the stuck watchdog
            // Runtime-separated reasoning (Ollama `reasoning`, DeepSeek-style
            // `reasoning_content`) arrives on its own field — route it
            // straight to the accordion, bypassing the typewriter/tag parser.
            if (e.payload.thinking) {
              // The runtime separates thinking for us, so the content stream
              // is pure answer — drop any speculative thinking-first stance.
              if (parser.speculative) {
                parser.inThink = false;
                parser.speculative = false;
              }
              charCount += e.payload.thinking.length;
              const store = useMessagesStore.getState();
              if (
                ownerMessages().find((m) => m.id === placeholderId)
                  ?.pendingSince !== undefined
              ) {
                store.patchMessage(
                  placeholderId,
                  { pendingSince: undefined },
                  ownerSessionId,
                );
              }
              store.appendThinkingToMessage(
                placeholderId,
                e.payload.thinking,
                ownerSessionId,
              );
            }
            charCount += e.payload.text.length;
            // Push into the typewriter buffer — the steady-rate interval will
            // drain it into the rendered message.
            pendingDisplay += e.payload.text;
          },
        );
        unlistenDone = await listen<{ runId: string }>("llm://done", (e) => {
          if (e.payload.runId !== runKey) return;
          if (genOf(runKey) !== myGen) {
            cleanup();
            return;
          }
          // Drain whatever is still buffered before flushing the think parser.
          streamEnded = true;
          while (pendingDisplay.length > 0) flushTypewriter();
          const { content, thinking, undoThinking } = flushThinkParser(parser, true);
          const store = useMessagesStore.getState();
          if (undoThinking > 0)
            store.reclaimThinkingToContent(placeholderId, undoThinking, ownerSessionId);
          if (content) store.appendToMessage(placeholderId, content, ownerSessionId);
          if (thinking)
            store.appendThinkingToMessage(placeholderId, thinking, ownerSessionId);
          clearRun();
          cleanup();
        });
        unlistenError = await listen<{ runId: string; message: string }>(
          "llm://error",
          (e) => {
            if (e.payload.runId !== runKey) return;
            if (genOf(runKey) !== myGen) {
              cleanup();
              return;
            }
            // Map the string payload onto an AppError so the banner shows
            // something actionable rather than a raw stderr blob.
            useMessagesStore.getState().attachErrorToMessage(
              placeholderId,
              inferLlmError(e.payload.message),
              ownerSessionId,
            );
            clearRun();
            cleanup();
          },
        );

        await callLlmStream(history, projectPath, modelId || null, runKey);
      } catch (err) {
        if (genOf(runKey) !== myGen) {
          cleanup();
          return;
        }
        useMessagesStore
          .getState()
          .attachErrorToMessage(placeholderId, asAppErrorSafe(err), ownerSessionId);
        clearRun();
        cleanup();
      }
    })();
  },
  stop: (sessionId) => {
    const targetSid =
      sessionId ?? useProjectsStore.getState().activeSessionId ?? "";
    const run = get().runs[targetSid];
    if (!run) return;

    // Bump this session's generation so its in-flight handler bails, and mark
    // it cancelled so the agent branch renders "[cancelled]" rather than a
    // crash when the killed process returns non-zero.
    bumpGen(targetSid);
    cancelledRuns.add(targetSid);

    // A built-in loop parked on an approval wait must be released (as "no"),
    // or the stopped run's promise would hang forever.
    builtinApprovalResolvers.get(targetSid)?.("n");

    // Drop the session from the running set. Its tokensPerSecBySession entry is
    // left at its last value so the meter still reads after a stop.
    set((st) => {
      const next = { ...st.runs };
      delete next[targetSid];
      return { runs: next };
    });

    // Finalize the in-flight placeholder so it doesn't stay "Thinking…" forever.
    // If the model never sent a chunk, "[stopped]" makes the abandonment visible.
    if (run.placeholderId) {
      finalizePlaceholder(run.placeholderId, "stopped", targetSid);
    }
    // Clear any tool row left "running" so the session's working indicator
    // resolves immediately.
    useMessagesStore.getState().closeRunningTools(targetSid);

    // Tell the backend to stop THIS run. We don't track which engine the run
    // used, so signal both — each is a no-op if this run id isn't registered.
    void stopAgent(targetSid);
    void stopLlmStream(targetSid);
    // Only hard-abort the shared builtin runtime when nothing else is running,
    // so stopping one session never kills another's generation on the same model.
    if (Object.keys(get().runs).length === 0 && builtinRuntimeActive()) {
      void abortRuntime();
    }
  },

  answerQuestion: (sessionId, text, remember) => {
    const run = get().runs[sessionId];
    const q = run?.pendingQuestion;
    // A built-in loop run waits on an in-process resolver, not a PTY: hand it
    // the answer directly. Agent runs get the reply typed into their PTY
    // (run id == session id).
    const resolver = builtinApprovalResolvers.get(sessionId);
    if (resolver) {
      resolver(text);
    } else {
      void answerAgent(sessionId, text);
    }
    // Remember the answer for identical future prompts in this session.
    if (remember && q) {
      let m = rememberedAnswers.get(sessionId);
      if (!m) {
        m = new Map();
        rememberedAnswers.set(sessionId, m);
      }
      m.set(q.prompt, text);
    }
    // Clear the pending question so the card dismisses and the run resumes.
    set((st) =>
      st.runs[sessionId]
        ? {
            runs: {
              ...st.runs,
              [sessionId]: { ...st.runs[sessionId], pendingQuestion: null },
            },
          }
        : {},
    );
  },

  pause: (sessionId) => {
    const sid = sessionId ?? useProjectsStore.getState().activeSessionId ?? "";
    if (!sid || !get().runs[sid]) return;
    // Only flip the UI if the backend actually suspended the process — returns
    // false on an unsupported platform (non-Unix), so no false "paused" state.
    // The backend also emits agent://state on success (idempotent with this).
    void pauseAgent(sid).then((ok) => {
      if (!ok) return;
      set((st) =>
        st.runs[sid]
          ? { runs: { ...st.runs, [sid]: { ...st.runs[sid], runState: "paused" } } }
          : {},
      );
    });
  },

  resume: (sessionId) => {
    const sid = sessionId ?? useProjectsStore.getState().activeSessionId ?? "";
    if (!sid || !get().runs[sid]) return;
    void resumeAgent(sid).then((ok) => {
      if (!ok) return;
      set((st) =>
        st.runs[sid]
          ? { runs: { ...st.runs, [sid]: { ...st.runs[sid], runState: "running" } } }
          : {},
      );
    });
  },

  rollbackTo: async (sessionId, sha) => {
    const pp = projectPathForSession(sessionId);
    if (!pp) return;
    await restoreCheckpoint(pp, sessionId, sha);
    // Surface the reverted tree immediately in any open browser/file panes.
    useWorkspaceStore.getState().bumpPreviewReload();
  },

  rollbackToPrerun: async (sessionId) => {
    const sid = sessionId ?? useProjectsStore.getState().activeSessionId ?? "";
    if (!sid) return;
    const cps = get().checkpointsBySession[sid] ?? [];
    // Most recent "Before run" baseline (last run's, when a session re-ran).
    const prerun = [...cps].reverse().find((c) => c.kind === "prerun");
    if (prerun) await get().rollbackTo(sid, prerun.sha);
  },

  manualCheckpoint: async (sessionId) => {
    const sid = sessionId ?? useProjectsStore.getState().activeSessionId ?? "";
    if (!sid) return;
    const pp = projectPathForSession(sid);
    if (!pp) return;
    await createCheckpoint(pp, sid, "Manual checkpoint", "manual");
  },

  restart: (sessionId) => {
    const sid = sessionId ?? useProjectsStore.getState().activeSessionId ?? "";
    if (!sid) return;
    const task = get().lastTaskBySession[sid];
    if (!task) return;
    // Re-issuing goes through submit(), which keys the run to the *active*
    // session; only restart the one in view so the new run can't land elsewhere.
    if (sid !== useProjectsStore.getState().activeSessionId) return;
    // Stop any in-flight run, roll back to the pre-run baseline, then re-submit.
    if (get().runs[sid]) get().stop(sid);
    void (async () => {
      await get().rollbackToPrerun(sid);
      set({ inputText: task });
      get().submit({ force: true });
    })();
  },
}));

/**
 * True when the *active* (currently viewed) session has a run in flight. This
 * is what the chatbox pickers/meter care about — they lock for the session
 * you're looking at, not for some other session running in the background.
 */
export function useActiveSessionRunning(): boolean {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  return useChatStore((s) => (activeSessionId ? !!s.runs[activeSessionId] : false));
}

/**
 * Last-measured decode rate (tokens/sec) for the *active* (currently viewed)
 * session. With concurrent runs each session tracks its own rate, so the meter
 * shows the rate for the session you're looking at — not whichever finished last.
 */
export function useActiveSessionTokensPerSec(): number {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  return useChatStore((s) =>
    activeSessionId ? (s.tokensPerSecBySession[activeSessionId] ?? 0) : 0,
  );
}

/**
 * The interactive question the *active* (currently viewed) session's agent is
 * waiting on, or null. Drives the inline approval card + the paused composer.
 */
export function useActiveSessionQuestion(): AgentQuestion | null {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  return useChatStore((s) =>
    activeSessionId ? (s.runs[activeSessionId]?.pendingQuestion ?? null) : null,
  );
}

/** True when any session (running in the background or not) is awaiting input. */
export function useAnySessionAwaiting(): boolean {
  return useChatStore((s) =>
    Object.values(s.runs).some((r) => !!r.pendingQuestion),
  );
}

/** Lifecycle of the *active* session's run, or null when it isn't running. */
export function useActiveSessionRunState(): "running" | "paused" | null {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  return useChatStore((s) =>
    activeSessionId ? (s.runs[activeSessionId]?.runState ?? null) : null,
  );
}

/**
 * Timestamp of the *active* session run's last activity once the stale-agent
 * watchdog has flagged it as silent past the threshold, or null while it's
 * moving / not running. Drives the "agent may be stale" banner; the run keeps
 * standing by regardless.
 */
export function useActiveSessionStaleSince(): number | null {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  return useChatStore((s) =>
    activeSessionId ? (s.runs[activeSessionId]?.staleSince ?? null) : null,
  );
}

const EMPTY_CHECKPOINTS: Checkpoint[] = [];

/** Checkpoint timeline for the *active* session (oldest first). */
export function useActiveSessionCheckpoints(): Checkpoint[] {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  return useChatStore((s) =>
    activeSessionId
      ? (s.checkpointsBySession[activeSessionId] ?? EMPTY_CHECKPOINTS)
      : EMPTY_CHECKPOINTS,
  );
}

/**
 * Whether checkpoints are available for the active session (its project is a
 * git repo). Defaults to true until probed so the UI doesn't flash "unavailable".
 */
export function useActiveSessionCheckpointsAvailable(): boolean {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  return useChatStore((s) =>
    activeSessionId
      ? (s.checkpointsAvailableBySession[activeSessionId] ?? true)
      : true,
  );
}
