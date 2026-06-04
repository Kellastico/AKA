import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import { useMessagesStore, type Message } from "../../stores/use-messages-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { MessageItem } from "./MessageItem";
import { AgentActivityAccordion } from "./AgentActivityAccordion";
import { WelcomeHero } from "../chatbox/WelcomeHero";

// Distance from bottom (in pixels) under which we still consider the user to
// be "following" the stream. Anything further than this pauses auto-scroll so
// the user can read earlier content without being yanked back down.
const STICKY_THRESHOLD_PX = 80;
// Show the "scroll to bottom" affordance once the user has scrolled up past
// this distance — comfortably clear of the sticky threshold so it doesn't
// flicker on/off while reading near the bottom.
const SCROLL_DOWN_THRESHOLD_PX = 220;

/**
 * A "group" is either a single user/assistant message or a run of consecutive
 * tool messages that get collapsed into the AgentActivityAccordion.
 */
type MessageGroup =
  | { kind: "single"; message: Message; key: string }
  | { kind: "tool-run"; messages: Message[]; key: string };

export function ChatHistory() {
  const messages = useMessagesStore((s) => s.messages);
  const isFull = useWorkspaceStore((s) => s.extraPanes.length === 0);
  const ref = useRef<HTMLDivElement>(null);
  // Whether we should keep pinning to the bottom on new content. Starts true
  // (initial render scrolls to bottom). Flips to false the moment the user
  // scrolls up. Flips back to true when they scroll back to the bottom OR
  // when a brand-new message is appended (so a fresh submit always shows).
  const stickRef = useRef(true);
  const prevLenRef = useRef(messages.length);
  // Drives the floating "scroll to bottom" button — true whenever the user has
  // scrolled meaningfully up from the bottom.
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Watch the scroll position; pause auto-scroll when the user moves up.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickRef.current = dist < STICKY_THRESHOLD_PX;
      setShowScrollDown(dist > SCROLL_DOWN_THRESHOLD_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToBottom = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = true;
    setShowScrollDown(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // Total character count drives the layout effect during streaming — content
  // grows but `messages.length` stays the same as the placeholder fills in.
  const contentSize = useMemo(
    () =>
      messages.reduce(
        (acc, m) => acc + m.content.length + (m.thinkingContent?.length ?? 0),
        0,
      ),
    [messages],
  );

  /**
   * Group consecutive tool messages into accordion runs so they don't flood
   * the chat thread. Non-tool messages stay as individual entries.
   */
  const groups = useMemo<MessageGroup[]>(() => {
    const result: MessageGroup[] = [];
    for (const m of messages) {
      if (m.role === "tool") {
        const last = result[result.length - 1];
        if (last?.kind === "tool-run") {
          last.messages.push(m);
        } else {
          result.push({ kind: "tool-run", messages: [m], key: `run-${m.id}` });
        }
      } else {
        result.push({ kind: "single", message: m, key: m.id });
      }
    }
    return result;
  }, [messages]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A new message was just appended — always re-anchor to bottom so the
    // user's own send doesn't disappear off-screen, even if they'd scrolled
    // up earlier.
    if (messages.length > prevLenRef.current) {
      stickRef.current = true;
    }
    prevLenRef.current = messages.length;

    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, contentSize]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        className="flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {messages.length === 0 ? (
          <WelcomeHero compact={!isFull} />
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            {groups.map((group) =>
              group.kind === "tool-run" ? (
                <AgentActivityAccordion key={group.key} messages={group.messages} />
              ) : (
                <MessageItem key={group.key} message={group.message} />
              ),
            )}
          </div>
        )}
      </div>

      {/* Jump-to-latest — appears whenever the user has scrolled up, pinned to
          the bottom-center of the chat. */}
      {showScrollDown && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/85 shadow-[0_4px_20px_rgba(0,0,0,0.4)] backdrop-blur-xl transition-all hover:bg-white/20 hover:text-white active:scale-95 animate-slide-up-in"
        >
          Scroll to Bottom
          <ArrowDown size={14} weight="bold" />
        </button>
      )}
    </div>
  );
}
