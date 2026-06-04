import { ReactNode } from "react";

/**
 * Shared collapse/expand wrapper. EVERY accordion in the app wraps its body in
 * this so the open/close animation is identical no matter where it lives.
 *
 * Uses the grid-rows `0fr ↔ 1fr` trick: the body animates smoothly to and from
 * its natural ("auto") height without us having to measure it, and the content
 * stays mounted so closing animates too (not just opening).
 *
 * Keep the collapsible content's own margins INSIDE `children` — the wrapper
 * clips with `overflow-hidden`, so external margins would leak past the clip.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden={!open}
      className={[
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className ?? "",
      ].join(" ")}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
