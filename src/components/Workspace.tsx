import { Fragment } from "react";
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
const ENTER_ANIM = "pane-enter 280ms cubic-bezier(0.4, 0, 0.2, 1) both";
const LAYOUT_TRANSITION = "flex-basis 280ms cubic-bezier(0.4, 0, 0.2, 1)";

export function Workspace() {
  const extraPanes = useWorkspaceStore((s) => s.extraPanes);
  const ratios = useWorkspaceStore((s) => s.paneRatios);
  const dragging = useWorkspaceStore((s) => s.dragging);

  const totalRatio = ratios.reduce((a, b) => a + b, 0) || 1;
  const resizerCount = extraPanes.length;
  const basisFor = (r: number) =>
    `calc((100% - ${resizerCount * RESIZER_W}px) * ${r / totalRatio})`;
  const transition = dragging ? "none" : LAYOUT_TRANSITION;

  const ordered = orderedPanes(extraPanes);
  const chatIdx = chatVisualIndex(extraPanes);

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
      <div className="flex h-full px-6">
        {slots.map((slot, i) => (
          <Fragment key={slot.kind === "chat" ? "chat" : slot.pane.id}>
            {i > 0 && <Resizer index={i - 1} />}
            {slot.kind === "chat" ? (
              <div
                className="flex h-full"
                style={{
                  flex: `0 0 ${basisFor(ratios[i] ?? 1)}`,
                  minWidth: CHAT_MIN,
                  transition,
                }}
              >
                <ChatPane />
              </div>
            ) : (
              <div
                className="flex h-full"
                style={{
                  flex: `0 0 ${basisFor(ratios[i] ?? 1)}`,
                  minWidth: PANE_MIN,
                  transition,
                  animation: ENTER_ANIM,
                }}
              >
                <Pane pane={slot.pane} />
              </div>
            )}
          </Fragment>
        ))}
      </div>
      <ProjectModeTakeover />
    </div>
  );
}
