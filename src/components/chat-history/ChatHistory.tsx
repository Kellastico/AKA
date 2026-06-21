import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import { useMessagesStore } from "../../stores/use-messages-store";
import { useActiveSessionRunning } from "../../stores/use-chat-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { MessageItem } from "./MessageItem";
import { RunTimeline } from "./RunTimeline";
import { groupRunMessages, type RunGroup } from "./run-grouping";
import { WelcomeHero } from "../chatbox/WelcomeHero";

// Distance from bottom (in pixels) under which we still consider the user to
// be "following" the stream. Anything further than this pauses auto-scroll so
// the user can read earlier content without being yanked back down.
const STICKY_THRESHOLD_PX = 80;
// Show the "scroll to bottom" affordance once the user has scrolled up past
// this distance — comfortably clear of the sticky threshold so it doesn't
// flicker on/off while reading near the bottom.
const SCROLL_DOWN_THRESHOLD_PX = 220;

export function ChatHistory() {
  const messages = useMessagesStore((s) => s.messages);
  const isFull = useWorkspaceStore((s) => s.extraPanes.length === 0);
  // The single source of truth for "this session is running" — the same flag
  // the composer's stop button reads. Handed to the latest run's timeline so
  // its footer status can't drift out of sync with the composer.
  const sessionRunning = useActiveSessionRunning();
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

  // Fold the flat list into render groups: agent runs (interleaved reasoning +
  // tool + answer) become one RunTimeline; everything else stays standalone.
  const groups = useMemo<RunGroup[]>(() => groupRunMessages(messages), [messages]);

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
            {groups.map((group, idx) =>
              group.kind === "run" ? (
                <RunTimeline
                  key={group.key}
                  messages={group.messages}
                  // Only the last group can be the in-flight run; older runs are
                  // settled history (live = false) so they always read as Done.
                  live={idx === groups.length - 1 ? sessionRunning : false}
                />
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
