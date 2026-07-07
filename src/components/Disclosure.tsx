import type { ReactNode } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";

/**
 * Lightweight accordion row shared across the app (Custom Agent panel, the
 * Runtime modal's Advanced Settings). Purely presentational — the caller owns
 * the open state.
 *
 * Two looks:
 * - `variant="row"` (default): header matches the panel action rows ("Add
 *   custom endpoint") — same text-xs size, same hover treatment — and the
 *   expanded content flows flat underneath, no nested box. Use this inside
 *   popover panels so accordion content reads as a direct part of the panel.
 * - `variant="boxed"`: the original smaller header + outlined body, used by
 *   denser form surfaces (Custom Agent panel).
 */
export function Disclosure({
  open,
  onToggle,
  label,
  icon,
  children,
  variant = "row",
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  variant?: "row" | "boxed";
}) {
  if (variant === "boxed") {
    return (
      <div className="flex flex-col gap-2">
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-[11px] font-medium text-white/55 hover:text-white/85"
        >
          {open ? (
            <CaretDown size={11} className="shrink-0 text-white/40" />
          ) : (
            <CaretRight size={11} className="shrink-0 text-white/40" />
          )}
          {icon}
          {label}
        </button>
        {open && (
          <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2">
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-xl px-2 py-2 text-left text-xs text-white/70 hover:bg-white/10 hover:text-white"
      >
        {open ? (
          <CaretDown size={12} className="shrink-0 text-white/50" />
        ) : (
          <CaretRight size={12} className="shrink-0 text-white/50" />
        )}
        {icon}
        {label}
      </button>
      {open && <div className="flex flex-col gap-2">{children}</div>}
    </div>
  );
}
