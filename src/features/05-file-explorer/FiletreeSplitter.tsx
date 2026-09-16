import { useRef } from "react";
import {
  MAX_TREE_RATIO,
  MIN_TREE_RATIO,
  useFiletreeStore,
} from "./use-filetree-store";

/**
 * Drag handle between the tree and the open file. Same pointer-capture
 * approach as the workspace `Resizer` — capture guarantees move/up events keep
 * arriving even when the cursor crosses a textarea or the file table — but it
 * writes a single ratio into the filetree store instead of the pane array.
 */
export function FiletreeSplitter({
  containerRef,
  onDraggingChange,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = ref.current;
    const container = containerRef.current;
    if (!el || !container) return;
    el.setPointerCapture(e.pointerId);

    const rect = container.getBoundingClientRect();
    onDraggingChange(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      if (rect.width <= 0) return;
      // Absolute cursor position rather than a delta: the ratio can't drift
      // out of step with the pointer over a long drag.
      useFiletreeStore
        .getState()
        .setTreeRatio((ev.clientX - rect.left) / rect.width);
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.releasePointerCapture(e.pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onDraggingChange(false);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const treeRatio = useFiletreeStore((s) => s.treeRatio);
  const nudge = (delta: number) =>
    useFiletreeStore.getState().setTreeRatio(treeRatio + delta);

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          nudge(-0.02);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          nudge(0.02);
        }
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file tree"
      aria-valuenow={Math.round(treeRatio * 100)}
      aria-valuemin={Math.round(MIN_TREE_RATIO * 100)}
      aria-valuemax={Math.round(MAX_TREE_RATIO * 100)}
      tabIndex={0}
      className="group relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center border-x border-white/8 hover:border-white/15 focus:outline-none"
    >
      <div className="h-10 w-0.5 rounded-full bg-white/10 transition-colors group-hover:bg-white/30 group-active:bg-white/50 group-focus:bg-white/40" />
    </div>
  );
}
