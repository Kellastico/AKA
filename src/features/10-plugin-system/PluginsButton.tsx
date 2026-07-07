import { useEffect, useRef, useState } from "react";
import { CaretDown, PuzzlePiece } from "@phosphor-icons/react";
import { Popover } from "../../components/Popover";
import { Tooltip } from "../../components/Tooltip";
import { useMediaQuery } from "../../lib/use-media-query";
import { McpServersPanel } from "./McpServersPanel";
import { useMcpStore } from "./use-mcp-store";

/**
 * Below this window width the pill collapses to icon-only so the top bar's
 * left cluster can't crowd the centered omnibox. In icon-only mode (and ONLY
 * then) the name comes back as a hover tooltip — when the label is visible,
 * a tooltip would just repeat it.
 */
const COMPACT_QUERY = "(max-width: 1120px)";

/**
 * Top-bar plugins control — owns the MCP servers popover, the same interaction
 * pattern as RuntimeButton/ConnectionPanel but a fully separate surface and
 * store (MCP servers are a tool source, not a model runtime).
 */
export function PluginsButton() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const compact = useMediaQuery(COMPACT_QUERY);
  const connectedCount = useMcpStore(
    (s) => Object.values(s.statusByName).filter((st) => st.state === "connected").length,
  );

  const button = (
    <button
      ref={ref}
      onClick={() => setOpen((v) => !v)}
      className={[
        "inline-flex h-9 items-center rounded-full border border-white/20 bg-white/10 text-xs text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl transition-colors hover:border-white/30 hover:bg-white/20",
        compact ? "w-9 justify-center" : "gap-1.5 px-3",
      ].join(" ")}
      aria-label={
        connectedCount > 0
          ? `Plugins — ${connectedCount} MCP server${connectedCount === 1 ? "" : "s"} connected`
          : "Plugins"
      }
    >
      <PuzzlePiece size={14} className="shrink-0" />
      {!compact ? (
        <>
          <span className="shrink-0">Plugins</span>
          {connectedCount > 0 ? (
            <span className="truncate text-white/55">· {connectedCount}</span>
          ) : null}
          <CaretDown
            size={11}
            weight="bold"
            className={[
              "ml-0.5 shrink-0 text-white/50 transition-transform",
              open ? "rotate-180" : "",
            ].join(" ")}
          />
        </>
      ) : null}
    </button>
  );

  return (
    <>
      {compact ? (
        <Tooltip
          label={connectedCount > 0 ? `Plugins · ${connectedCount}` : "Plugins"}
          side="bottom"
        >
          {button}
        </Tooltip>
      ) : (
        button
      )}

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} width={320}>
        <McpServersPanel />
      </Popover>
    </>
  );
}

/**
 * Load persisted MCP servers and reconnect them on app start — the same
 * bootstrap-hook pattern as useBootstrapRuntime (ConnectionPanel.tsx).
 */
export function useBootstrapMcp() {
  const bootstrap = useMcpStore((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
}
