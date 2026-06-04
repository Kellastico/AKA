import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowUp, Check, Robot, X } from "@phosphor-icons/react";
import { useProjectsStore } from "../../stores/use-projects-store";
import {
  useActiveSessionCheckpoints,
  useActiveSessionCheckpointsAvailable,
  useActiveSessionQuestion,
  useChatStore,
} from "../../stores/use-chat-store";

/**
 * Inline approval card for an agent's interactive prompt. Rendered just above
 * the composer for the *active* session (per-session, so concurrent sessions
 * don't fight over a global modal). A frosted surface — a touch lighter than
 * the reasoning accordion — so it reads as "the app is asking you something."
 *
 * Two shapes, both detected generically by the backend:
 *   - confirm → yes/no: Approve (sends "y") on the LEFT, Reject ("n") on the RIGHT.
 *   - input   → free-text reply.
 */
export function AgentQuestionCard() {
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  const question = useActiveSessionQuestion();
  const answerQuestion = useChatStore((s) => s.answerQuestion);
  const rollbackToPrerun = useChatStore((s) => s.rollbackToPrerun);
  const checkpoints = useActiveSessionCheckpoints();
  const checkpointsAvailable = useActiveSessionCheckpointsAvailable();

  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset transient state whenever a new question appears.
  useEffect(() => {
    setReplying(false);
    setText("");
    setRemember(false);
  }, [question?.prompt, activeSessionId]);

  useEffect(() => {
    if (replying || question?.kind === "input") inputRef.current?.focus();
  }, [replying, question?.kind]);

  if (!activeSessionId || !question) return null;
  const sid = activeSessionId;

  const send = (value: string) => {
    answerQuestion(sid, value, remember);
  };
  const sendText = () => {
    if (!text.trim()) return;
    send(text);
  };

  const isInput = question.kind === "input";
  // "Reject & undo" is offered only when we can actually undo — a git repo with
  // a recorded pre-run baseline to roll the working tree back to.
  const canUndo =
    checkpointsAvailable && checkpoints.some((c) => c.kind === "prerun");
  const rejectAndUndo = () => {
    send("n");
    void rollbackToPrerun(sid);
  };

  return (
    <div className="mb-2 rounded-2xl border border-white/25 bg-white/[0.16] p-3.5 shadow-[0_14px_44px_rgba(0,0,0,0.38)] backdrop-blur-xl">
      {/* Header */}
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-300">
          <Robot size={16} weight="duotone" />
        </span>
        <span className="text-[13px] font-semibold text-white">
          {isInput ? "Agent is asking" : "Agent needs your approval"}
        </span>
        <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
          ⏸ Paused
        </span>
      </div>

      {/* The exact prompt the agent emitted */}
      <div className="mb-3 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 font-mono text-[11.5px] leading-snug text-white/85">
        {question.prompt}
      </div>

      {isInput ? (
        <ReplyField
          inputRef={inputRef}
          value={text}
          onChange={setText}
          onSend={sendText}
        />
      ) : replying ? (
        <ReplyField
          inputRef={inputRef}
          value={text}
          onChange={setText}
          onSend={sendText}
          onCancel={() => setReplying(false)}
        />
      ) : (
        // Approve LEFT, Reject RIGHT (LTR reading order).
        <div className="flex items-center gap-2">
          <button
            onClick={() => send("y")}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400 px-4 py-2 text-[12.5px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-300"
          >
            <Check size={13} weight="bold" />
            Approve
          </button>
          <button
            onClick={() => setReplying(true)}
            className="rounded-full border border-white/15 px-3 py-2 text-[12px] text-white/70 transition-colors hover:bg-white/10"
          >
            Reply…
          </button>
          <span className="flex-1" />
          <button
            onClick={() => send("n")}
            className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/60 px-4 py-2 text-[12.5px] font-medium text-rose-200 transition-colors hover:bg-rose-500/10"
          >
            <X size={13} weight="bold" />
            Reject
          </button>
        </div>
      )}

      {!isInput && !replying && canUndo && (
        <button
          onClick={rejectAndUndo}
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-rose-300/80 transition-colors hover:text-rose-200"
        >
          <ArrowCounterClockwise size={12} weight="bold" />
          Reject &amp; roll back to before the run
        </button>
      )}

      <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-[11px] text-white/45 hover:text-white/65">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-3.5 w-3.5 accent-fuchsia-500"
        />
        Remember my answer for identical prompts this session
      </label>
    </div>
  );
}

function ReplyField({
  inputRef,
  value,
  onChange,
  onSend,
  onCancel,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCancel?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSend();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Type your reply…"
        spellCheck={false}
        className="flex-1 rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-[12px] text-white outline-none placeholder:text-white/30 focus:border-white/40"
      />
      {onCancel && (
        <button
          onClick={onCancel}
          className="rounded-lg px-2.5 py-2 text-[12px] text-white/55 hover:bg-white/10"
        >
          Cancel
        </button>
      )}
      <button
        onClick={onSend}
        disabled={!value.trim()}
        aria-label="Send reply"
        className="flex h-9 w-9 items-center justify-center rounded-lg bg-fuchsia-500 text-white transition-colors hover:bg-fuchsia-400 disabled:opacity-40"
      >
        <ArrowUp size={15} weight="bold" />
      </button>
    </div>
  );
}
