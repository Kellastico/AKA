import { create } from "zustand";
import {
  summarizeSession,
  type ChatMessage,
  type SummarizerRuntime,
} from "../lib/tauri/commands";
import { useProjectConfigStore } from "./use-project-config-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";
import { useMessagesStore } from "./use-messages-store";

// Tracks the active session's message history and orchestrates the LLM/agent
// swap handoff: outgoing model summarizes its own session → history is cleared
// → summary is staged as the next session's system prefix. Mode swaps
// (Ask/Edit/Agent) and `hydrateFromProject` never go through here — only
// user-initiated LLM or agent swaps via the pickers do.

export type SessionMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "agent"
  | "verify";

export type SessionMessage = {
  id: number;
  role: SessionMessageRole;
  content: string;
  timestamp: number;
};

export type HandoffStatus = "running" | "ok" | "failed";

export type HandoffKind = "model" | "agent";

export type HandoffEntry = {
  id: number;
  timestamp: number;
  kind: HandoffKind;
  previous: string;
  next: string;
  status: HandoffStatus;
  /** Final summary text, set once status flips to "ok". */
  summary: string | null;
  /** Error text, set once status flips to "failed". */
  error: string | null;
};

type SessionState = {
  messages: SessionMessage[];
  /** True while `summarize_session` is in flight. Drives the inline pill. */
  summarizing: boolean;
  /** Prepended to the next session's system context — cleared on consume. */
  summaryPrefix: string | null;
  /** Audit trail rendered as collapsible blocks in the task workspace. */
  handoffs: HandoffEntry[];

  appendMessage: (role: SessionMessageRole, content: string) => void;
  /** Collapse a full agent run into a single logical session event. */
  appendAgentEvent: (
    task: string,
    filesChanged: string[],
    verification: "passed" | "failed" | "n/a",
  ) => void;
  /** Take and clear the staged system prefix. Returns null if none pending. */
  consumeSummaryPrefix: () => string | null;
  clearSession: () => void;

  /**
   * Run a user-initiated swap. If history is empty, applies immediately;
   * otherwise summarizes via the outgoing runtime first. `apply` performs the
   * actual swap (e.g. `useRuntimeStore.selectModel`) and runs unconditionally
   * — even when summarization fails the swap proceeds, with a hard reset.
   */
  performHandoff: (
    kind: HandoffKind,
    previous: string,
    next: string,
    apply: () => Promise<void>,
  ) => Promise<void>;

  /**
   * Start a new session: summarize the current session (if it has messages),
   * then clear all messages so the pill locks reset and a fresh session begins.
   * Used by the "New session" affordance in the chat footer.
   */
  startNewSession: () => Promise<void>;
};

let seq = 1;
const nextId = () => seq++;

/** Snapshot the currently-active runtime — the model that will write the summary. */
function captureOutgoingRuntime(): SummarizerRuntime {
  const rt = useRuntimeStore.getState();
  const cfg = useProjectConfigStore.getState().config;
  return {
    baseUrl: rt.active?.baseUrl ?? cfg?.runtime.base_url ?? "",
    model: rt.selectedModelId ?? cfg?.runtime.model ?? "",
    apiKey: rt.active?.apiKey ?? cfg?.runtime.api_key ?? null,
  };
}

/** Map a session role to a chat role the summarizer can consume. */
function toChatMessage(m: SessionMessage): ChatMessage {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") return { role: "assistant", content: m.content };
  // agent + verify + system collapse to user — the summarizer treats the whole
  // history as a single user-side recap and never speaks "as" the agent.
  return { role: "user", content: `[${m.role}] ${m.content}` };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  messages: [],
  summarizing: false,
  summaryPrefix: null,
  handoffs: [],

  appendMessage: (role, content) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { id: nextId(), role, content, timestamp: Date.now() },
      ],
    })),

  appendAgentEvent: (task, filesChanged, verification) => {
    const files = filesChanged.length ? filesChanged.join(", ") : "(none)";
    const content = `Agent completed task: ${task}. Files modified: ${files}. Verification: ${verification}.`;
    get().appendMessage("agent", content);
  },

  consumeSummaryPrefix: () => {
    const p = get().summaryPrefix;
    if (p) set({ summaryPrefix: null });
    return p;
  },

  clearSession: () => set({ messages: [], summaryPrefix: null }),

  startNewSession: async () => {
    const { messages } = get();

    if (messages.length === 0) {
      useMessagesStore.getState().clear();
      return;
    }

    const outgoing = captureOutgoingRuntime();
    set({ summarizing: true });

    let prefix: string | null = null;
    try {
      const summary = await summarizeSession(messages.map(toChatMessage), outgoing);
      prefix = `Previous session summary: ${summary}`;
    } catch {
      // Summarization failed — start fresh anyway, no prefix carried forward.
    }

    set({ summarizing: false, messages: [], summaryPrefix: prefix });
    useMessagesStore.getState().clear();
  },

  performHandoff: async (kind, previous, next, apply) => {
    const messages = get().messages;

    // Empty history: nothing to carry forward — apply the swap immediately.
    if (messages.length === 0) {
      await apply();
      return;
    }

    const outgoing = captureOutgoingRuntime();
    const entry: HandoffEntry = {
      id: nextId(),
      timestamp: Date.now(),
      kind,
      previous,
      next,
      status: "running",
      summary: null,
      error: null,
    };
    set((s) => ({ summarizing: true, handoffs: [...s.handoffs, entry] }));

    let summary: string;
    try {
      summary = await summarizeSession(messages.map(toChatMessage), outgoing);
    } catch (err) {
      // Hard reset on failure — the new session starts cold, and we warn.
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        summarizing: false,
        messages: [],
        summaryPrefix: null,
        handoffs: s.handoffs.map((h) =>
          h.id === entry.id ? { ...h, status: "failed", error: msg } : h,
        ),
      }));
      await apply();
      return;
    }

    set((s) => ({
      summarizing: false,
      messages: [],
      summaryPrefix: `Previous session summary: ${summary}`,
      handoffs: s.handoffs.map((h) =>
        h.id === entry.id ? { ...h, status: "ok", summary } : h,
      ),
    }));

    await apply();
  },
}));
