import { useEffect, useRef } from "react";
import { Broom, Stop } from "@phosphor-icons/react";
import { useDevServerStore } from "../../stores/use-dev-server-store";
import { Tooltip } from "../Tooltip";

/**
 * Streaming text view for the dev-server process. Subscribed via Zustand to
 * [[use-dev-server-store]] — no event listeners of its own. Scroll auto-pins
 * to the bottom when the user is already at the bottom; if they've scrolled
 * up to read history, new chunks don't yank them back down.
 */
export function OutputContent() {
  const status = useDevServerStore((s) => s.status);
  const log = useDevServerStore((s) => s.log);
  const stop = useDevServerStore((s) => s.stop);
  const clearLog = useDevServerStore((s) => s.clearLog);
  const exitCode = useDevServerStore((s) => s.exitCode);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Track whether the user is at the bottom so we don't fight their scroll.
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const slack = 16;
    pinnedRef.current =
      el.scrollHeight - el.clientHeight - el.scrollTop < slack;
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const statusLabel =
    status === "running"
      ? "Running"
      : status === "recovering"
        ? "Freeing port & restarting…"
        : status === "exited"
          ? `Exited ${exitCode ?? ""}`.trim()
          : status === "failed"
            ? `Failed ${exitCode ?? ""}`.trim()
            : "Idle";

  const statusColor =
    status === "running"
      ? "bg-emerald-400"
      : status === "recovering"
        ? "bg-sky-400 animate-pulse"
        : status === "failed"
          ? "bg-red-400"
          : status === "exited"
            ? "bg-amber-400"
            : "bg-white/30";

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <div className="flex items-center gap-2 text-[11px] text-white/55">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span>{statusLabel}</span>
          <span className="text-white/30">·</span>
          <span className="text-white/40">{log.length} lines</span>
        </div>
        <div className="flex items-center gap-1">
          {(status === "running" || status === "recovering") && (
            <Tooltip label="Stop server" side="bottom">
              <button
                onClick={() => stop()}
                className="flex h-7 w-7 items-center justify-center rounded-full text-red-300/85 hover:bg-red-500/15 hover:text-red-200"
                aria-label="Stop dev server"
              >
                <Stop size={14} weight="fill" />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Clear" side="bottom">
            <button
              onClick={() => clearLog()}
              disabled={log.length === 0}
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white/85 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Clear output"
            >
              <Broom size={14} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 font-mono text-[11.5px] leading-[1.5]"
      >
        {log.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-white/30">
            No output yet — start a dev server from a preview pane
          </div>
        ) : (
          log.map((l, i) => (
            <div
              key={l.id}
              className={[
                "flex items-start gap-2",
                l.stream === "stderr" ? "text-red-300/85" : "text-white/75",
              ].join(" ")}
            >
              <span className="min-w-0 flex-1 break-all">{l.line || " "}</span>
              <span className="shrink-0 select-none text-[10px] tabular-nums text-white/20">
                {i + 1}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
