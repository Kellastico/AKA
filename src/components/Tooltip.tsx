import { ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GAP = 6;

export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  function handleEnter() {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      x: r.left + r.width / 2,
      y: side === "top" ? r.top - GAP : r.bottom + GAP,
    });
  }

  return (
    <div
      ref={wrapRef}
      className="inline-flex"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: pos.x,
              top: pos.y,
              transform:
                side === "top"
                  ? "translateX(-50%) translateY(-100%)"
                  : "translateX(-50%)",
              zIndex: 9999,
            }}
          >
            <div
              role="tooltip"
              className="pointer-events-none animate-morph-in whitespace-nowrap rounded-lg border border-white/15 bg-black/75 px-2 py-1 text-[11px] text-white/80 backdrop-blur-xl"
            >
              {label}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
