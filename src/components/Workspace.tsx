import { Fragment, useEffect } from "react";
import { ChatPane } from "./ChatPane";
import { Pane } from "./Pane";
import { Resizer } from "./Resizer";
import { ProjectModeTakeover } from "./project-displays/ProjectModeTakeover";
import {
  chatVisualIndex,
  orderedPanes,
  useWorkspaceStore,
} from "../stores/use-workspace-store";

const CHAT_MIN = 280;
const PANE_MIN = 240;
/** Width occupied by each Resizer (w-2 = 8px + mx-0.5 = 4px). Keep in sync with Resizer.tsx. */
const RESIZER_W = 12;
/** Horizontal gutter of the workspace row (px-6). The expanded pane keeps it so
 *  its rounded card lines up with the top bar and project rail above/below. */
const GUTTER = 24;
const ENTER_ANIM = "pane-enter 280ms cubic-bezier(0.4, 0, 0.2, 1) both";
const EXPAND_ANIM = "pane-expand 220ms cubic-bezier(0.16, 1, 0.3, 1) both";
const LAYOUT_TRANSITION = "flex-basis 280ms cubic-bezier(0.4, 0, 0.2, 1)";

export function Workspace() {
  const extraPanes = useWorkspaceStore((s) => s.extraPanes);
  const ratios = useWorkspaceStore((s) => s.paneRatios);
  const dragging = useWorkspaceStore((s) => s.dragging);
  const expandedPaneId = useWorkspaceStore((s) => s.expandedPaneId);
  const collapseExpandedPane = useWorkspaceStore((s) => s.collapseExpandedPane);

  const totalRatio = ratios.reduce((a, b) => a + b, 0) || 1;
  const resizerCount = extraPanes.length;
  const basisFor = (r: number) =>
    `calc((100% - ${resizerCount * RESIZER_W}px) * ${r / totalRatio})`;
  const transition = dragging ? "none" : LAYOUT_TRANSITION;

  const ordered = orderedPanes(extraPanes);
  const chatIdx = chatVisualIndex(extraPanes);

  // Everything that isn't the expanded pane goes invisible. `visibility`
  // rather than `display: none` on purpose: it keeps the layout box and the
  // render tree, so a Preview pane's iframe sitting alongside doesn't reload
  // (and the chat keeps its scroll position) when it comes back.
  const hiddenWhileExpanded: React.CSSProperties = expandedPaneId
    ? { visibility: "hidden", pointerEvents: "none" }
    : {};

  // Esc collapses. Registered at the document so it works no matter where focus
  // sits inside the expanded pane — but only while something IS expanded, so a
  // normal Esc (clearing a search box, closing a popover) is left alone.
  useEffect(() => {
    if (!expandedPaneId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      collapseExpandedPane();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expandedPaneId, collapseExpandedPane]);

  type Slot =
    | { kind: "chat" }
    | { kind: "pane"; pane: (typeof ordered)[number] };
  const slots: Slot[] = [
    ...ordered.slice(0, chatIdx).map((pane) => ({ kind: "pane" as const, pane })),
    { kind: "chat" },
    ...ordered.slice(chatIdx).map((pane) => ({ kind: "pane" as const, pane })),
  ];

  return (
    <div className="relative h-full">
      <div className="relative flex h-full px-6">
        {/* Transparent click-catcher so a click on the gutter around the
            expanded pane collapses it. No scrim colour: the panes underneath
            are hidden outright (below), so there is nothing to mask — and a
            tinted scrim would show as a flat band in the gutter, against the
            app's gradient. */}
        {expandedPaneId && (
          <div
            className="absolute inset-0 z-20"
            onMouseDown={collapseExpandedPane}
          />
        )}
        {slots.map((slot, i) => {
          const isExpanded =
            slot.kind === "pane" && slot.pane.id === expandedPaneId;
          return (
            <Fragment key={slot.kind === "chat" ? "chat" : slot.pane.id}>
              {i > 0 && !expandedPaneId && <Resizer index={i - 1} />}
              {slot.kind === "chat" ? (
                <div
                  className="flex h-full"
                  style={{
                    flex: `0 0 ${basisFor(ratios[i] ?? 1)}`,
                    minWidth: CHAT_MIN,
                    transition,
                    ...hiddenWhileExpanded,
                  }}
                >
                  <ChatPane />
                </div>
              ) : (
                // The expanded pane is lifted out of the flex flow by position
                // alone — it never unmounts, so a Preview iframe keeps its page
                // and scroll position across expand/collapse.
                <div
                  className="flex h-full"
                  style={
                    isExpanded
                      ? {
                          position: "absolute",
                          // Below ProjectModeTakeover's z-30 (same stacking
                          // context) so project mode still covers everything.
                          zIndex: 25,
                          top: 0,
                          bottom: 0,
                          left: GUTTER,
                          right: GUTTER,
                          animation: EXPAND_ANIM,
                        }
                      : {
                          flex: `0 0 ${basisFor(ratios[i] ?? 1)}`,
                          minWidth: PANE_MIN,
                          transition,
                          animation: ENTER_ANIM,
                          ...hiddenWhileExpanded,
                        }
                  }
                >
                  <Pane pane={slot.pane} />
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      <ProjectModeTakeover />
    </div>
  );
}
