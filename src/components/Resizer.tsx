import { useRef } from "react";
import { useWorkspaceStore } from "../stores/use-workspace-store";

const MIN_RATIO = 0.25;

export function Resizer({ index }: { index: number }) {
  const ref = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = ref.current;
    const container = el?.parentElement;
    if (!el || !container) return;

    // Capture the pointer so every subsequent pointermove/pointerup routes
    // to this element even when the cursor flies over iframes, canvas, or
    // other pointer-eating surfaces (xterm, browser preview, etc.).
    el.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const containerW = container.getBoundingClientRect().width;
    const startRatios = useWorkspaceStore.getState().paneRatios;
    const sum = startRatios.reduce((a, b) => a + b, 0);

    useWorkspaceStore.getState().setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dRatio = (dx / containerW) * sum;
      const left = startRatios[index] + dRatio;
      const right = startRatios[index + 1] - dRatio;
      const minRatio = (sum / startRatios.length) * MIN_RATIO;
      if (left < minRatio || right < minRatio) return;
      const next = [...startRatios];
      next[index] = left;
      next[index + 1] = right;
      useWorkspaceStore.getState().setPaneRatios(next);
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.releasePointerCapture(e.pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      useWorkspaceStore.getState().setDragging(false);
    };

    // Listen on the element, not window — pointer capture guarantees delivery
    // regardless of what element is physically under the cursor.
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className="group relative mx-0.5 flex w-2 shrink-0 cursor-col-resize items-center justify-center"
    >
      <div className="h-12 w-0.5 rounded-full bg-ink/10 transition-colors group-hover:bg-ink/30 group-active:bg-ink/50" />
    </div>
  );
}
