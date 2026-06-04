import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMessagesStore } from "./use-messages-store";
import { useAgentsStore } from "./use-agents-store";
import { useAttachmentsStore } from "./use-attachments-store";
import { useProjectConfigStore } from "./use-project-config-store";
import { useProjectsStore } from "./use-projects-store";
import {
  builtinEndpoint,
  useRuntimeStore,
} from "../features/01-llm-provider/use-runtime-store";
import { useWorkspaceStore } from "./use-workspace-store";
import { parserForAgent } from "../lib/agent-parsers";
import {
  abortRuntime,
  asAppError,
  callLlmStream,
  listDir,
  readImageBase64,
  readTextFile,
  restartRuntime,
  answerAgent,
  runAgent,
  stopAgent,
  pauseAgent,
  resumeAgent,
  stopLlmStream,
  createCheckpoint,
  restoreCheckpoint,
  checkpointsAvailable,
  runFileChanges,
  type AgentQuestion,
  type AgentStateEvent,
  type AppError,
  type ChatMessage,
  type Checkpoint,
  type CheckpointCreated,
  type ContentPart,
} from "../lib/tauri/commands";
import { isMultimodalModel } from "../lib/model-capabilities";
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
      // Just a textual anchor — the actual bytes travel as an `image_url`
      // content part built by the history builder. Image attachment is gated
      // to vision-capable models (see AttachButton), so this is never the only
      // thing the model receives.
      sections.push(`### Image: ${item.name}`);
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

  // Network / runtime issues.
  if (
    m.includes("connection") ||
    m.includes("connect") ||
    m.includes("offline") ||
    m.includes("dns") ||
    m.includes("timed out") ||
    m.includes("refused") ||
    m.includes("http 5")
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

// Incremental SSE parser that splits a token stream into "content" and
// "thinking" deltas as <think>…</think> (or <thinking>…</thinking>) blocks
// open and close. Tags split across chunks are buffered until they can be
// matched, so the UI never flashes raw tag fragments.
type ThinkParser = { buffer: string; inThink: boolean };
const OPEN_TAGS = ["<thinking>", "<think>"];
const CLOSE_TAGS = ["</thinking>", "</think>"];

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
): { content: string; thinking: string } {
  state.buffer += chunk;
  let content = "";
  let thinking = "";
  while (state.buffer.length > 0) {
    if (state.inThink) {
      const hit = findFirstTag(state.buffer, CLOSE_TAGS);
      if (!hit) {
        const hold = potentialTagAtEnd(state.buffer, CLOSE_TAGS);
        thinking += state.buffer.slice(0, state.buffer.length - hold);
        state.buffer = state.buffer.slice(state.buffer.length - hold);
        break;
      }
      thinking += state.buffer.slice(0, hit.index);
      state.buffer = state.buffer.slice(hit.index + hit.len);
      state.inThink = false;
    } else {
      const hit = findFirstTag(state.buffer, OPEN_TAGS);
      if (!hit) {
        const hold = potentialTagAtEnd(state.buffer, OPEN_TAGS);
        content += state.buffer.slice(0, state.buffer.length - hold);
        state.buffer = state.buffer.slice(state.buffer.length - hold);
        break;
      }
      content += state.buffer.slice(0, hit.index);
      state.buffer = state.buffer.slice(hit.index + hit.len);
      state.inThink = true;
    }
  }
  return { content, thinking };
}

function flushThinkParser(state: ThinkParser): { content: string; thinking: string } {
  if (state.buffer.length === 0) return { content: "", thinking: "" };
  const remaining = state.buffer;
  state.buffer = "";
  return state.inThink
    ? { content: "", thinking: remaining }
    : { content: remaining, thinking: "" };
}


export type ChatMode = "ask" | "edit" | "agent";

export const CHAT_MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: "ask", label: "Chat Only", hint: "Pure conversation — nothing touches your repo" },
  { id: "edit", label: "Strategize", hint: "LLM plans the work and shows diffs for your approval" },
  { id: "agent", label: "Execute", hint: "Dispatch the agent to run the task end-to-end" },
];

type ChatState = {
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  /**
   * Restore the mode from the active project's `.äkä/config.json`. Falls
   * back to "agent" for any unrecognized value (older configs, etc.).
   */
  hydrateMode: (mode: string) => void;
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
   * Answer the interactive prompt a session's agent is waiting on. Types `text`
   * into the agent's PTY, clears the pending question, and (when `remember`) auto-
   * answers later identical prompts in that session. Approve = "y", Reject = "n",
   * or any free-text reply.
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
    if (
      !rt.active ||
      !rt.healthy ||
      !rt.selectedModelId ||
      !agent ||
      // Agent mode needs a bin to run, but we no longer block on the `installed`
      // detection flag: the user registered this agent, and the backend resolves
      // the binary via the login shell at spawn. If it genuinely can't be found,
      // the run surfaces a clear "command not found" AgentCrash rather than a
      // silent, un-actionable refusal here.
      (mode === "agent" && !agent.bin.trim())
    ) {
      return;
    }

    // Pre-flight #2: the *project's* config must carry an agent.bin (the
    // backend reads it from disk per run). Globals can be green while the
    // project's .äkä/config.json is still empty — the gap that produced the
    // "agent.bin is not configured" crash and the "no agent saved" dead-end.
    // Rather than refuse, the agent branch below mirrors the selected agent
    // into the project config just before spawning, so a valid selection always
    // launches even if the on-load auto-heal lost a startup race. We only bail
    // when the selected agent has no bin to mirror (the blank escape hatch).
    if (mode === "agent" && !agent.bin.trim()) {
      return;
    }

    const modelId = rt.selectedModelId ?? "";
    const agentId = ag.selectedAgentId;
    const ps = useProjectsStore.getState();
    const projectPath =
      ps.projects.find((p) => p.id === ps.activeProjectId)?.path ?? "";

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

    if (mode === "agent") {
      // The pre-flight above guaranteed a selected agent; this guard just
      // narrows the type for the parser below.
      if (!agent) {
        clearRun();
        return;
      }
      // Agent mode: spawn the agent subprocess and live-stream its stdout
      // into a placeholder assistant message so the user sees progress as
      // it happens, not after a long silence.
      void (async () => {
        const attachmentCtx = await resolveAttachments();
        const task = attachmentCtx ? text + attachmentCtx : text;

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
        const thinkParser: ThinkParser = { buffer: "", inThink: false };
        const eventParser = parserForAgent(agent.bin);
        let currentToolMessageId: string | null = null;
        // Kind of the in-flight tool, captured at tool_start so tool_end can
        // decide whether the step mutated the tree (write/run) and warrants a
        // checkpoint.
        let currentToolKind: string | null = null;

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

        const applyToolEnd = (event: {
          ok: boolean;
          elapsedMs?: number;
          preview?: string;
          path?: string;
          linesAdded?: number;
          linesRemoved?: number;
        }) => {
          if (!currentToolMessageId) return;
          const store = useMessagesStore.getState();
          const patch: Record<string, unknown> = {
            toolStatus: event.ok ? "done" : "failed",
          };
          if (event.elapsedMs !== undefined) patch.toolElapsedMs = event.elapsedMs;
          if (event.preview !== undefined) patch.toolPreview = event.preview;
          if (event.path !== undefined) patch.toolPath = event.path;
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

        try {
          unlistenOutput = await listen<{ runId: string; line: string; stream: string }>(
            "agent://output",
            (e) => {
              // Only this session's run — a concurrent session's output carries
              // a different runId and must not leak into this bubble.
              if (e.payload.runId !== runKey) return;
              if (genOf(runKey) !== myGen) return;
              const store = useMessagesStore.getState();

              const events = eventParser.feed(e.payload.line);
              for (const event of events) {
                if (event.type === "tool_start") {
                  // Insert tool rows BEFORE the final-answer placeholder so the
                  // "Agent worked" accordion renders above the result, not below
                  // it. The placeholder stays last and keeps the Thinking
                  // indicator at the bottom until the answer streams in.
                  const toolId = store.addBefore(
                    placeholderId,
                    {
                      role: "tool",
                      content: "",
                      toolKind: event.kind,
                      toolName: event.name,
                      toolPath: event.path,
                      toolStatus: "running",
                      agentId: agentId || undefined,
                      modelId: modelId || undefined,
                    },
                    ownerSessionId,
                  );
                  currentToolMessageId = toolId;
                  currentToolKind = event.kind;
                } else if (event.type === "tool_end") {
                  applyToolEnd(event);
                } else {
                  // text → count chars for TPS, then route through <think> parser
                  agentCharCount += event.text.length;
                  const { content, thinking } = processThinkChunk(
                    thinkParser,
                    event.text + "\n",
                  );
                  if (content) {
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
                    store.appendToMessage(placeholderId, content, ownerSessionId);
                  }
                  if (thinking)
                    store.appendThinkingToMessage(
                      placeholderId,
                      thinking,
                      ownerSessionId,
                    );
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
            await runAgent(
              task,
              projectPath,
              runKey,
              selectedModelId ?? undefined,
              active?.baseUrl ?? undefined,
              active?.apiKey ?? null,
            );
          }
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
          // Drain the agent parser first — any tool still in-flight at
          // process exit gets closed as failed so the row doesn't pulse
          // forever.
          for (const event of eventParser.flush()) {
            if (event.type === "tool_end") applyToolEnd(event);
            else if (event.type === "text") {
              const { content, thinking } = processThinkChunk(
                thinkParser,
                event.text + "\n",
              );
              const store = useMessagesStore.getState();
              if (content)
                store.appendToMessage(placeholderId, content, ownerSessionId);
              if (thinking)
                store.appendThinkingToMessage(
                  placeholderId,
                  thinking,
                  ownerSessionId,
                );
            }
          }
          // Then drain the <think> parser for any half-buffered tail.
          const { content, thinking } = flushThinkParser(thinkParser);
          const store = useMessagesStore.getState();
          if (content) store.appendToMessage(placeholderId, content, ownerSessionId);
          if (thinking)
            store.appendThinkingToMessage(placeholderId, thinking, ownerSessionId);
          // Stop the agent TPS interval. Intentionally keep the last measured
          // tokensPerSec value so users can read performance after the run.
          clearInterval(agentTpsInterval);

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
      const multimodal = isMultimodalModel(modelId);
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

      const parser: ThinkParser = { buffer: "", inThink: false };

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
        const { content, thinking } = processThinkChunk(parser, slice);
        const store = useMessagesStore.getState();
        const target = ownerMessages().find((m) => m.id === placeholderId);
        if (target?.pendingSince !== undefined) {
          store.patchMessage(
            placeholderId,
            { pendingSince: undefined },
            ownerSessionId,
          );
        }
        if (content) store.appendToMessage(placeholderId, content, ownerSessionId);
        if (thinking)
          store.appendThinkingToMessage(placeholderId, thinking, ownerSessionId);
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
        unlistenChunk = await listen<{ runId: string; text: string }>(
          "llm://chunk",
          (e) => {
            // Ignore other sessions' streams — they carry a different runId.
            if (e.payload.runId !== runKey) return;
            if (genOf(runKey) !== myGen) return;
            charCount += e.payload.text.length;
            lastChunkAt = Date.now(); // feed the stuck watchdog
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
          const { content, thinking } = flushThinkParser(parser);
          const store = useMessagesStore.getState();
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
    // Type the reply into the agent's PTY (run id == session id).
    void answerAgent(sessionId, text);
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
