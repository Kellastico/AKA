import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/use-workspace-store";
import { useActiveSessionQuestion, useChatStore } from "../stores/use-chat-store";
import { useDragStore } from "../stores/use-drag-store";
import { ChatBoxFooter } from "./chatbox/ChatBoxFooter";
import { AttachmentChips } from "./chatbox/AttachmentChips";
import { DropOverlay } from "./chatbox/DropOverlay";
import { UsageMeter } from "./chatbox/UsageMeter";
import { SetupChecklist } from "./chatbox/SetupChecklist";
import { AgentQuestionCard } from "./chatbox/AgentQuestionCard";
import { CheckpointTimeline } from "./chatbox/CheckpointTimeline";
import { ChatHistory } from "./chat-history/ChatHistory";

// Width below which chatbox footer controls collapse to icon-only.
// Calibrated so all four pickers + send button fit on one row without
// horizontal scroll at the threshold.
const COMPACT_BREAKPOINT_PX = 520;

export function ChatPane() {
  const isFull = useWorkspaceStore((s) => s.extraPanes.length === 0);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);

  if (isFull) {
    return (
      <div
        onMouseDown={() => setActivePane(null)}
        className="flex h-full w-full flex-col items-center"
      >
        <div className="flex min-h-0 w-full flex-1 flex-col sm:w-[60%] sm:max-w-[1080px]">
          <ChatHistory />
        </div>
        <div className="w-full sm:w-[60%] sm:max-w-[1080px]">
          <CheckpointTimeline />
          <AgentQuestionCard />
          <ChatBox variant="lg" />
        </div>
      </div>
    );
  }

  return (
    <div
      onMouseDown={() => setActivePane(null)}
      className="flex h-full min-w-0 w-full flex-col overflow-hidden"
    >
      <ChatHistory />
      <div className="pt-3">
        <CheckpointTimeline />
        <AgentQuestionCard />
        <ChatBox variant="sm" />
      </div>
    </div>
  );
}

function ChatBox({ variant }: { variant: "sm" | "lg" }) {
  const inputText = useChatStore((s) => s.inputText);
  const setInputText = useChatStore((s) => s.setInputText);
  const submit = useChatStore((s) => s.submit);
  const awaitingAnswer = useActiveSessionQuestion();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Start compact when in a narrow pane slot; ResizeObserver will correct it
  // on first paint regardless of initial value.
  const [compact, setCompact] = useState(variant === "sm");

  // Drag-overlay state — drives the border colour and the overlay component.
  const dragActive = useDragStore((s) => s.active);
  const dragAccepted = useDragStore((s) => s.acceptedCount);
  const dragRejected = useDragStore((s) => s.rejectedCount);
  const allRejected = dragActive && dragRejected > 0 && dragAccepted === 0;
  const mixed = dragActive && dragRejected > 0 && dragAccepted > 0;

  // Auto-resize the textarea to fit its content every time the text changes.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [inputText]);

  // Drive the compact/full footer state from actual rendered width, not from
  // the variant prop — both layouts use the same textarea now.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w > 0 && w < COMPACT_BREAKPOINT_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter inserts a newline. Don't fire while the user
    // is mid-IME-composition (e.g. accepting a candidate with Enter) or it
    // would submit a half-typed character.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5">
      <SetupChecklist />
      <div className="flex justify-end px-1">
        <UsageMeter />
      </div>
      <div
        className={[
          "relative rounded-3xl border bg-white/10 p-3 backdrop-blur-3xl transition-[border-color,box-shadow] duration-200",
          allRejected
            ? "border-red-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_0_24px_rgba(248,113,113,0.25)]"
            : mixed
              ? "border-amber-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_0_24px_rgba(251,191,36,0.25)]"
              : dragActive
                ? "border-violet-400/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_0_24px_rgba(167,139,250,0.25)]"
                : "border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_20px_rgba(0,0,0,0.25)]",
        ].join(" ")}
      >
        <DropOverlay />
        <AttachmentChips />
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          wrap="soft"
          rows={3}
          className="block w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-2 pt-1 text-sm leading-relaxed placeholder:text-ink/40 focus:outline-none"
          style={{ maxHeight: "16rem" }}
          placeholder={
            awaitingAnswer
              ? "Agent is paused — answer the question above to continue."
              : "Describe a task — ↵ to launch, ⇧↵ for a new line."
          }
        />
        <ChatBoxFooter compact={compact} />
      </div>
    </div>
  );
}
