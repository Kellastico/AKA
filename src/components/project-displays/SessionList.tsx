import { useEffect, useRef, useState } from "react";
import {
  ChatCircle,
  Clock,
  Question,
  SpinnerGap,
  PencilSimple,
  Plus,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import {
  Project,
  Session,
  useProjectsStore,
} from "../../stores/use-projects-store";
import { useMessagesStore } from "../../stores/use-messages-store";
import { useChatStore } from "../../stores/use-chat-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { adviceForNewSession } from "../../lib/session-concurrency";
import { SameModelAdviceModal } from "../SameModelAdviceModal";
import { usePrefsStore } from "../../stores/use-prefs-store";
import { Tooltip } from "../Tooltip";

export function SessionList({
  project,
  onPick,
}: {
  project: Project;
  onPick: () => void;
}) {
  const activateSession = useProjectsStore((s) => s.activateSession);
  const startNewSession = useProjectsStore((s) => s.startNewSession);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  // Each in-flight run is keyed by its launching session — surface that as a
  // live "working" indicator on the matching row. Multiple may be active at once.
  const runs = useChatStore((s) => s.runs);
  const totalRamGb = useRuntimeStore((s) => s.hardware?.totalRamGb ?? null);
  const selectedModelId = useRuntimeStore((s) => s.selectedModelId);
  const suppressSameModelAdvice = usePrefsStore((s) => s.suppressSameModelAdvice);
  const setSuppressSameModelAdvice = usePrefsStore(
    (s) => s.setSuppressSameModelAdvice,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [adviceOpen, setAdviceOpen] = useState(false);

  const createSession = () => {
    // The session-messages sync hook loads the new session's (empty) message
    // list as soon as activeSessionId changes; we just spawn the session and
    // reset the workspace panes.
    void startNewSession(project.id);
    useWorkspaceStore.getState().clearPanes();
    onPick();
  };
  // On a memory-limited machine with a run already in flight, advise reusing the
  // current model before spinning up another session — different models each
  // load their own weights and can overwhelm RAM. Advisory only; Continue proceeds.
  const handleNewSession = () => {
    const runningSessions = Object.entries(runs).map(([sessionId, r]) => ({
      sessionId,
      modelId: r.modelId,
    }));
    if (
      !suppressSameModelAdvice &&
      adviceForNewSession({ totalRamGb, runningSessions })
    ) {
      setAdviceOpen(true);
      return;
    }
    createSession();
  };

  return (
    <div className="flex flex-col">
      {/* Only the session ROWS scroll — the "New session" button below stays
          pinned so it's always one click away, even with a long list. */}
      <div className="max-h-72 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {project.sessions.length === 0 && (
          <div className="px-3 py-3 text-xs text-ink/40">No sessions yet</div>
        )}
        <div className="flex flex-col gap-1">
          {project.sessions.map((s) => (
            <SessionRow
              key={s.id}
              project={project}
              session={s}
              editing={editingId === s.id}
              isActive={
                project.id === activeProjectId && s.id === activeSessionId
              }
              isWorking={!!runs[s.id]}
              isAwaiting={!!runs[s.id]?.pendingQuestion}
              onStartEdit={() => setEditingId(s.id)}
              onEndEdit={() => setEditingId(null)}
              onRequestDelete={() => setPendingDelete(s)}
              onOpen={() => {
                activateSession(project.id, s.id);
                onPick();
              }}
            />
          ))}
        </div>
      </div>

      {/* Fixed footer — never scrolls out of reach. */}
      <div className="shrink-0">
        <div className="my-1 h-px bg-ink/10" />
        <button
          onClick={handleNewSession}
          className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white/90"
        >
          <Plus size={16} className="text-white/40" />
          New session
        </button>
      </div>

      {pendingDelete && (
        <DeleteConfirm
          session={pendingDelete}
          projectId={project.id}
          onCancel={() => setPendingDelete(null)}
          onConfirmed={() => setPendingDelete(null)}
        />
      )}
      <SameModelAdviceModal
        open={adviceOpen}
        currentModelId={selectedModelId}
        onProceed={(dontShowAgain) => {
          setAdviceOpen(false);
          if (dontShowAgain) void setSuppressSameModelAdvice(true);
          createSession();
        }}
        onCancel={() => setAdviceOpen(false)}
      />
    </div>
  );
}

function SessionRow({
  project,
  session,
  editing,
  isActive,
  isWorking,
  isAwaiting,
  onStartEdit,
  onEndEdit,
  onRequestDelete,
  onOpen,
}: {
  project: Project;
  session: Session;
  editing: boolean;
  /** True when this is the session the user is currently viewing. */
  isActive: boolean;
  /** True when a run is in flight for this session. */
  isWorking: boolean;
  /** True when this session's agent is paused waiting on the user's answer. */
  isAwaiting: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onRequestDelete: () => void;
  onOpen: () => void;
}) {
  const updateSessionTitle = useProjectsStore((s) => s.updateSessionTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(session.title);

  useEffect(() => {
    if (editing) {
      setDraft(session.title);
      // Defer to next tick so the input is in the DOM and selectable.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, session.title]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== session.title) {
      void updateSessionTitle(project.id, session.id, next);
    }
    onEndEdit();
  };

  // Persistent tinted background marks the row the user is currently
  // viewing. Kept distinct from `hover:bg-ink/5` so the focus signal
  // doesn't get washed out when the mouse moves across other rows.
  const activeStyle = isActive ? "bg-white/10" : "hover:bg-ink/5";

  return (
    <div
      className={[
        "group flex w-full items-center gap-2 rounded-2xl px-3 py-2",
        activeStyle,
      ].join(" ")}
    >
      {isAwaiting ? (
        <Tooltip label="Waiting for your answer">
          <Question
            size={16}
            weight="fill"
            className="shrink-0 animate-pulse text-amber-300"
            aria-label="Waiting for your answer"
          />
        </Tooltip>
      ) : isWorking ? (
        <Tooltip label="Working…">
          <SpinnerGap
            size={16}
            className="shrink-0 animate-spin text-ink/50"
            aria-label="Working"
          />
        </Tooltip>
      ) : (
        <ChatCircle size={16} className="shrink-0 text-ink/50" />
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onEndEdit();
            }
          }}
          className="flex-1 rounded-md border border-white/15 bg-black/30 px-2 py-0.5 text-sm text-white focus:border-white/30 focus:outline-none"
        />
      ) : (
        <button
          onClick={onOpen}
          onDoubleClick={onStartEdit}
          className="flex-1 truncate text-left text-sm"
          title="Click to open, double-click to rename"
        >
          {session.title}
        </button>
      )}
      <span className="hidden items-center gap-1 text-[11px] text-ink/40 group-hover:flex">
        <Clock size={12} />
        {session.updatedAt}
      </span>
      {!editing && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip label="Rename">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit();
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-ink/55 hover:bg-ink/10 hover:text-ink"
              aria-label="Rename session"
            >
              <PencilSimple size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Delete">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRequestDelete();
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-ink/55 hover:bg-rose-500/20 hover:text-rose-200"
              aria-label="Delete session"
            >
              <Trash size={12} />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

function DeleteConfirm({
  session,
  projectId,
  onCancel,
  onConfirmed,
}: {
  session: Session;
  projectId: string;
  onCancel: () => void;
  onConfirmed: () => void;
}) {
  const deleteSession = useProjectsStore((s) => s.deleteSession);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const confirm = () => {
    void deleteSession(projectId, session.id);
    // Drop the deleted session's archived messages too — otherwise they'd
    // leak in `sessionMessages` forever.
    useMessagesStore.getState().forgetSession(session.id);
    onConfirmed();
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Confirm delete session"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-[90vw] rounded-2xl border border-white/15 bg-zinc-900/95 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
      >
        <div className="mb-3 flex items-center gap-2">
          <Warning size={20} weight="fill" className="text-rose-300" />
          <h2 className="text-sm font-medium">Delete this session?</h2>
        </div>
        <p className="mb-2 text-sm text-white/80">
          You're about to delete the session:
        </p>
        <p className="mb-4 break-all rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-xs text-white/90">
          {session.title}
        </p>
        <p className="mb-4 text-xs text-white/60">
          This can't be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            className="rounded-md bg-rose-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-400"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectHeader({ project }: { project: Project }) {
  return (
    <div className="px-3 pt-2 pb-1">
      <div className="text-xs font-medium text-ink/60">{project.name}</div>
      <div className="truncate text-[11px] text-ink/40">{project.path}</div>
    </div>
  );
}
