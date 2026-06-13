import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import type { AppError } from "../lib/tauri/commands";
import { backfillSession } from "../lib/agent-parsers/cleanup";

export type MessageRole = "user" | "assistant" | "tool";

export type ToolKind = "write" | "read" | "run" | "search";

export type MessageAttachment = {
  kind: "file" | "folder" | "image" | "url";
  name: string;
  /**
   * Filesystem path. Persisted for image attachments so the chat history
   * builder can re-read and re-encode the bytes on later turns (keeping
   * multi-turn image conversations working), not just the turn it was sent on.
   */
  path?: string;
};

export type Message = {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  /** Model that generated this message. Set on assistant messages. */
  modelId?: string;
  /** Agent that produced this message or tool action. Set on assistant + tool messages. */
  agentId?: string;
  /** Reasoning/thinking block stripped from <think>…</think> before the main content. */
  thinkingContent?: string;
  /** Structured error from the backend — rendered as an ErrorBanner inside the message. */
  error?: AppError;
  /**
   * Materialized attachment payload — file contents, folder listings, URLs.
   * Appended to `content` when sending to the LLM, but NOT shown in the user
   * bubble (the chip row already conveys what's attached).
   */
  attachmentContext?: string;
  /**
   * Unix ms timestamp set when a placeholder assistant message is created
   * before the first chunk arrives. While this is set and `content` is empty,
   * the renderer shows a live "thinking" bubble with elapsed time. Cleared
   * once the first chunk lands.
   */
  pendingSince?: number;
  /**
   * Unix ms timestamp set when the first <think> chunk arrives. Pairs with
   * `thinkingEndedAt` to render the elapsed-reasoning counter on the
   * Reasoning toggle (same UX as the live Thinking bubble's timer).
   */
  thinkingStartedAt?: number;
  /**
   * Unix ms timestamp set when the closing </think> tag arrives OR when
   * the message is finalized — whichever comes first. While unset and
   * `thinkingStartedAt` is set, the counter ticks live.
   */
  thinkingEndedAt?: number;
  // Tool-only fields
  toolKind?: ToolKind;
  toolPath?: string;
  /** Display name of the tool — e.g. "read_file", "patch", "bash". */
  toolName?: string;
  /**
   * Live status. "running" shows a pulsing bullet; "done" shows ✓ in
   * the tool's accent colour; "failed" shows ✗ in red. Old tool messages
   * (pre-parser) default to "done" via the renderer.
   */
  toolStatus?: "running" | "done" | "failed";
  /** Total time the tool took, in ms — rendered next to the row. */
  toolElapsedMs?: number;
  /**
   * One-liner shown on the `⎿ <preview>` continuation row under the
   * tool name. Examples: "142 lines", "+3 / -2", "7 passed, 0 failed",
   * "Edited index.html:42".
   */
  toolPreview?: string;
  // Diff stats — set on assistant messages that produced code changes
  linesAdded?: number;
  linesRemoved?: number;
};

/**
 * Per-session metadata stored alongside message archives — lets each session
 * remember its own agent + model so switching sessions restores the pickers,
 * independent of the project's saved defaults.
 */
export type SessionMeta = {
  agentId?: string;
  modelId?: string;
};

type MessagesState = {
  /** Currently visible messages — the contents of the active session. */
  messages: Message[];
  /** Snapshot of every session's messages, keyed by session id. */
  sessionMessages: Record<string, Message[]>;
  /** Per-session agent + model, keyed by session id. */
  sessionMeta: Record<string, SessionMeta>;
  /** Which session the `messages` array belongs to, if any. */
  currentSessionId: string | null;
  /** Hydrate `sessionMessages` from `tauri-plugin-store`. Call once at app boot. */
  init: () => Promise<void>;
  /** Write the agent + model for a specific session. */
  setSessionMeta: (sessionId: string, patch: SessionMeta) => void;
  /**
   * Add a new message; returns the generated id so the caller can append to
   * it later. Pass `sessionId` to bind the message to a specific session
   * (used by background runs so their output never lands in whatever session
   * the user is currently viewing). Omit it to target the visible session.
   */
  add: (m: Omit<Message, "id" | "timestamp">, sessionId?: string | null) => string;
  /**
   * Like `add`, but inserts the new message immediately BEFORE `beforeId`
   * (instead of at the end). Used so an agent's tool rows render before its
   * final answer message. Falls back to appending if `beforeId` is missing.
   */
  addBefore: (
    beforeId: string,
    m: Omit<Message, "id" | "timestamp">,
    sessionId?: string | null,
  ) => string;
  /** Append text to the content of an existing message (used by streaming). */
  appendToMessage: (id: string, delta: string, sessionId?: string | null) => void;
  /** Shallow-merge a patch into an existing message — used to flip tool status. */
  patchMessage: (id: string, patch: Partial<Message>, sessionId?: string | null) => void;
  /** Append text to the thinkingContent of an existing message (used by streaming). */
  appendThinkingToMessage: (id: string, delta: string, sessionId?: string | null) => void;
  /**
   * Move the last `chars` characters of a message's content into its
   * thinkingContent. Used when the stream parser meets an orphan </think> —
   * the opener was prefilled by the model's chat template, so text already
   * streamed into the body retroactively turns out to be reasoning.
   */
  reclaimContentAsThinking: (
    id: string,
    chars: number,
    sessionId?: string | null,
  ) => void;
  /**
   * Inverse of reclaimContentAsThinking: move the last `chars` characters of
   * thinkingContent back into content. Used when a speculative thinking-first
   * parse turns out to be wrong (stream ended cleanly with no close tag) —
   * the text routed to the accordion was really the answer.
   */
  reclaimThinkingToContent: (
    id: string,
    chars: number,
    sessionId?: string | null,
  ) => void;
  /** Attach a structured error to a message — renders inline as an ErrorBanner. */
  attachErrorToMessage: (id: string, error: AppError, sessionId?: string | null) => void;
  /**
   * Post-stream parse: extract a leading <think>…</think> block from the
   * accumulated content and move it to `thinkingContent`. No-op when
   * incremental parsing already separated the two during streaming.
   */
  finalizeMessage: (id: string, sessionId?: string | null) => void;
  /**
   * Snapshot the current messages under the previous session id, then load the
   * incoming session's messages into `messages`. Pass `null` to clear.
   *
   * If `currentSessionId` is null but there are unattached "orphan" messages
   * (the user typed before any session existed), they're adopted into the
   * incoming session rather than dropped.
   */
  loadSession: (sessionId: string | null) => void;
  /**
   * Flip any tool messages still marked "running" in a session to "failed".
   * Safety net called when a run ends so a crashed/abandoned agent never
   * leaves the "Agent is working" accordion spinning forever.
   */
  closeRunningTools: (sessionId: string | null) => void;
  /** Drop a session's archived messages — call when a session is deleted. */
  forgetSession: (sessionId: string) => void;
  clear: () => void;
};

const STORE_FILE = "aka-session-messages.json";
const STORE_KEY = "sessionMessages";
const META_KEY = "sessionMeta";
const PERSIST_DEBOUNCE_MS = 500;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistEnabled = false;

/** Debounced write of the session-message archive to disk. */
function schedulePersist() {
  if (!persistEnabled) return;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const { sessionMessages, sessionMeta } = useMessagesStore.getState();
    void writeSnapshot(sessionMessages, sessionMeta);
  }, PERSIST_DEBOUNCE_MS);
}

async function writeSnapshot(
  snapshot: Record<string, Message[]>,
  meta: Record<string, SessionMeta>,
) {
  try {
    const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(STORE_KEY, snapshot);
    await store.set(META_KEY, meta);
    await store.save();
  } catch {
    // Outside Tauri (browser dev) — keep state in memory only.
  }
}

/**
 * Apply `transform` to the message list of a *specific* session and produce
 * the next state slice. This is what keeps background runs airtight: a run
 * launched in session A writes to A's bucket regardless of which session the
 * user is currently viewing.
 *
 *   • The session's archived bucket (`sessionMessages[sessionId]`) is always
 *     updated, so the run keeps filling its own history off-screen.
 *   • The visible `messages` array is updated ONLY when the targeted session
 *     is the one on screen — otherwise the current view is left untouched.
 *
 * A null `sessionId` (orphan messages typed before any session existed) is
 * treated as visible and mirrors nowhere, matching the legacy behaviour.
 */
function applyToSession(
  state: MessagesState,
  sessionId: string | null,
  transform: (msgs: Message[]) => Message[],
): Pick<MessagesState, "messages" | "sessionMessages"> {
  const isVisible = sessionId === state.currentSessionId;
  const source = isVisible
    ? state.messages
    : sessionId
      ? state.sessionMessages[sessionId] ?? []
      : state.messages;
  const next = transform(source);
  return {
    messages: isVisible ? next : state.messages,
    sessionMessages: sessionId
      ? { ...state.sessionMessages, [sessionId]: next }
      : state.sessionMessages,
  };
}

/** Resolve the target session for a mutation — explicit arg wins, else the
 *  session currently on screen. `undefined` means "no arg passed". */
function targetSession(
  state: MessagesState,
  sessionId: string | null | undefined,
): string | null {
  return sessionId === undefined ? state.currentSessionId : sessionId;
}

let msgSeq = 0;

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: [],
  sessionMessages: {},
  sessionMeta: {},
  currentSessionId: null,

  setSessionMeta: (sessionId, patch) => {
    set((s) => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionId]: { ...s.sessionMeta[sessionId], ...patch },
      },
    }));
    schedulePersist();
  },

  init: async () => {
    try {
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      const saved = await store.get<Record<string, Message[]>>(STORE_KEY);
      const savedMeta = await store.get<Record<string, SessionMeta>>(META_KEY);
      if (savedMeta && typeof savedMeta === "object") {
        set({ sessionMeta: savedMeta });
      }
      if (saved && typeof saved === "object") {
        // Scrub stale `pendingSince` markers. A placeholder that was in
        // flight when the previous run ended must NOT keep ticking after
        // reload — those streams are gone, the timer would be meaningless.
        // Any genuinely empty pending message is marked abandoned so the
        // chat history is unambiguous.
        const sanitized: Record<string, Message[]> = {};
        for (const [sid, msgs] of Object.entries(saved)) {
          const scrubbed = msgs.map((m) => {
            // A tool left "running" when the app closed is from a dead run —
            // no stream survives a reload. Close it so the "Agent is working"
            // accordion doesn't spin forever on stale history.
            const m2 =
              m.role === "tool" && m.toolStatus === "running"
                ? { ...m, toolStatus: "failed" as const }
                : m;
            if (m2.pendingSince === undefined) return m2;
            return {
              ...m2,
              pendingSince: undefined,
              content: m2.content.length > 0 ? m2.content : "[abandoned]",
            };
          });
          // Retroactive cleanup: re-run the agent-output parser over each
          // session so old assistant messages that contain raw SmallCode
          // trace (⚙ / ✓ / ┌─ / └─ glyphs in the message body) get split
          // into proper tool rows + a clean prose reply. Messages that
          // don't carry a SmallCode signature pass through unchanged, so
          // this is safe to run on every boot — it's idempotent.
          sanitized[sid] = backfillSession(scrubbed);
        }

        const update: Partial<MessagesState> = { sessionMessages: sanitized };
        // Race-safety: useProjectsStore.init typically completes before us
        // and fires `loadSession(restoredId)` against an empty
        // sessionMessages map. That call sets messages=[] and currentSessionId
        // to the restored id. Now that we have the real map on disk, re-sync
        // `messages` to the matching bucket so the past session's chat
        // history actually appears.
        const currentSessionId = get().currentSessionId;
        if (currentSessionId && sanitized[currentSessionId]) {
          update.messages = sanitized[currentSessionId];
        }
        set(update);
      }
    } catch {
      // Browser dev — nothing to hydrate.
    } finally {
      persistEnabled = true;
    }
  },

  add: (m, sessionId) => {
    const id = `msg-${Date.now()}-${++msgSeq}`;
    const message: Message = {
      ...m,
      id,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    };
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) => [
        ...msgs,
        message,
      ]),
    );
    schedulePersist();
    return id;
  },

  addBefore: (beforeId, m, sessionId) => {
    const id = `msg-${Date.now()}-${++msgSeq}`;
    const message: Message = {
      ...m,
      id,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    };
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) => {
        const idx = msgs.findIndex((x) => x.id === beforeId);
        if (idx === -1) return [...msgs, message];
        return [...msgs.slice(0, idx), message, ...msgs.slice(idx)];
      }),
    );
    schedulePersist();
    return id;
  },

  appendToMessage: (id, delta, sessionId) => {
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) =>
        msgs.map((m) => {
          if (m.id !== id) return m;
          // First non-thinking content arriving means reasoning is done —
          // freeze the counter so it stops ticking.
          const thinkingEndedAt =
            m.thinkingStartedAt !== undefined && m.thinkingEndedAt === undefined
              ? Date.now()
              : m.thinkingEndedAt;
          return { ...m, content: m.content + delta, thinkingEndedAt };
        }),
      ),
    );
    schedulePersist();
  },

  patchMessage: (id, patch, sessionId) => {
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) =>
        msgs.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      ),
    );
    schedulePersist();
  },

  appendThinkingToMessage: (id, delta, sessionId) => {
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) =>
        msgs.map((m) => {
          if (m.id !== id) return m;
          return {
            ...m,
            thinkingContent: (m.thinkingContent ?? "") + delta,
            // Stamp the start clock on the very first thinking chunk so
            // the Reasoning counter ticks from "0s" rather than from
            // message creation.
            thinkingStartedAt: m.thinkingStartedAt ?? Date.now(),
          };
        }),
      ),
    );
    schedulePersist();
  },

  reclaimContentAsThinking: (id, chars, sessionId) => {
    if (chars <= 0) return;
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) =>
        msgs.map((m) => {
          if (m.id !== id) return m;
          const cut = Math.max(0, m.content.length - chars);
          return {
            ...m,
            content: m.content.slice(0, cut),
            thinkingContent: (m.thinkingContent ?? "") + m.content.slice(cut),
            thinkingStartedAt: m.thinkingStartedAt ?? Date.now(),
          };
        }),
      ),
    );
    schedulePersist();
  },

  reclaimThinkingToContent: (id, chars, sessionId) => {
    if (chars <= 0) return;
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) =>
        msgs.map((m) => {
          if (m.id !== id) return m;
          const thinking = m.thinkingContent ?? "";
          const cut = Math.max(0, thinking.length - chars);
          const keep = thinking.slice(0, cut);
          return {
            ...m,
            content: m.content + thinking.slice(cut),
            thinkingContent: keep || undefined,
            // The accordion vanishes with its content — drop the clocks too
            // so an empty "Reasoning · 0s" row can't linger.
            thinkingStartedAt: keep ? m.thinkingStartedAt : undefined,
            thinkingEndedAt: keep ? m.thinkingEndedAt : undefined,
          };
        }),
      ),
    );
    schedulePersist();
  },

  attachErrorToMessage: (id, error, sessionId) => {
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) =>
        msgs.map((m) => (m.id === id ? { ...m, error } : m)),
      ),
    );
    schedulePersist();
  },

  finalizeMessage: (id, sessionId) => {
    set((state) =>
      applyToSession(state, targetSession(state, sessionId), (msgs) =>
        msgs.map((m) => {
          if (m.id !== id) return m;
          // Safety net: if appendToMessage never fired (model produced
          // ONLY thinking, no answer) we still need to freeze the counter.
          const thinkingEndedAt =
            m.thinkingStartedAt !== undefined && m.thinkingEndedAt === undefined
              ? Date.now()
              : m.thinkingEndedAt;
          const match = m.content.match(
            /^<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/i,
          );
          if (match) {
            return {
              ...m,
              thinkingContent: match[1].trim(),
              content: m.content.slice(match[0].length).trim(),
              thinkingEndedAt,
            };
          }
          // Orphan close tag: R1-style templates prefill the opener, so the
          // text only ever carries </think>. Everything before the first
          // close (with no opener in between) is reasoning.
          const orphan = m.content.match(/^([\s\S]*?)<\/think(?:ing)?>\s*/i);
          if (orphan && !/<think(?:ing)?>/i.test(orphan[1])) {
            return {
              ...m,
              thinkingContent: orphan[1].trim(),
              content: m.content.slice(orphan[0].length).trim(),
              thinkingEndedAt,
            };
          }
          return { ...m, thinkingEndedAt };
        }),
      ),
    );
    schedulePersist();
  },

  loadSession: (sessionId) => {
    const { messages, sessionMessages, currentSessionId } = get();
    let archived = sessionMessages;

    if (currentSessionId) {
      // Normal case: archive the visible messages under the previous session.
      archived = { ...sessionMessages, [currentSessionId]: messages };
    } else if (sessionId && messages.length > 0) {
      // Orphan adoption: messages typed before any session was active. Append
      // them to the incoming session's archive so they're not lost.
      const existing = sessionMessages[sessionId] ?? [];
      archived = { ...sessionMessages, [sessionId]: [...existing, ...messages] };
    }

    set({
      currentSessionId: sessionId,
      sessionMessages: archived,
      messages: sessionId ? (archived[sessionId] ?? []) : [],
    });
    schedulePersist();
  },

  closeRunningTools: (sessionId) => {
    set((state) =>
      applyToSession(state, sessionId, (msgs) =>
        msgs.map((m) =>
          m.role === "tool" && m.toolStatus === "running"
            ? { ...m, toolStatus: "failed" as const }
            : m,
        ),
      ),
    );
    schedulePersist();
  },

  forgetSession: (sessionId) => {
    const { sessionMessages, sessionMeta, currentSessionId, messages } = get();
    const next = { ...sessionMessages };
    delete next[sessionId];
    const nextMeta = { ...sessionMeta };
    delete nextMeta[sessionId];
    set({
      sessionMessages: next,
      sessionMeta: nextMeta,
      messages: currentSessionId === sessionId ? [] : messages,
      currentSessionId:
        currentSessionId === sessionId ? null : currentSessionId,
    });
    schedulePersist();
  },

  clear: () => {
    set((state) => applyToSession(state, state.currentSessionId, () => []));
    schedulePersist();
  },
}));
