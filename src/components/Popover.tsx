import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * RULE: Every popover modal in this project MUST share this container and its
 * chrome (rounded-2xl glass, directional shadow, optional header with auto
 * divider, Close Modal footer). The popover opens FROM the anchor's position
 * (no gap) so it morphs in-place visually replacing the trigger. Do NOT pass
 * `className` just to strip the footer or restyle the chrome — features only
 * adjust the content inside `children` / `header`. The only allowed
 * per-instance variation is `width` (default 288, "anchor" to match anchor
 * width).
 */
type PopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  header?: ReactNode;
  className?: string;
  /** Popover width. Number = fixed px. "anchor" = match the anchor element's width. Default: 288. */
  width?: number | "anchor";
  /**
   * When true, the popover sits flush against the anchor (no overlap, no gap)
   * and reveals downward/upward like the anchor itself is growing. The shared
   * edge is unrounded and unbordered so the anchor + popover read as one shape.
   * Use this for combobox-style searchboxes where the input must stay visible
   * and the results extend beneath it.
   */
  attach?: boolean;
};

/**
 * Parse an `rgb()` / `rgba()` string into { r, g, b, a } (0–255 / 0–1).
 * Returns null for "transparent" or anything unparseable.
 */
function parseRgba(
  css: string,
): { r: number; g: number; b: number; a: number } | null {
  const m = css.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/,
  );
  if (!m) return null;
  return {
    r: parseInt(m[1]),
    g: parseInt(m[2]),
    b: parseInt(m[3]),
    a: m[4] !== undefined ? parseFloat(m[4]) : 1,
  };
}

/**
 * Relative luminance (0 = black, 1 = white) of an RGB triple (0–255 each).
 * Uses the simplified BT.601 luma formula — good enough for a contrast check.
 */
function luma(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Determine whether the popover is sitting over a light background.
 *
 * Two checks, either of which triggers the dark-chrome fallback:
 *
 * 1. Iframe overlap — the Preview pane renders a website inside an <iframe>.
 *    We can't read pixels from inside it, so any overlap is treated as
 *    "potentially light" and triggers the solid dark card.
 *
 * 2. Computed background walk — from the anchor element upward, find the
 *    first ancestor with a non-transparent background and measure its luma.
 *    Luma > 0.55 = light surface → use dark card. This covers any future
 *    light-themed AKA pane that isn't an iframe.
 */
function detectLightBackground(
  popoverEl: HTMLElement,
  anchorEl: HTMLElement | null,
): boolean {
  const rect = popoverEl.getBoundingClientRect();

  // Check 1: iframe overlap
  for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
    const r = iframe.getBoundingClientRect();
    const overlaps =
      rect.left < r.right &&
      rect.right > r.left &&
      rect.top < r.bottom &&
      rect.bottom > r.top;
    if (overlaps) return true;
  }

  // Check 2: walk anchor ancestors for a non-transparent background color
  let el: Element | null = anchorEl?.parentElement ?? document.body;
  while (el && el !== document.documentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    const parsed = parseRgba(bg);
    if (parsed && parsed.a > 0.3) {
      return luma(parsed.r, parsed.g, parsed.b) > 0.55;
    }
    el = el.parentElement;
  }

  return false;
}

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  header,
  className,
  width = 288,
  attach = false,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(open);
  const [isClosing, setIsClosing] = useState(false);
  /** True when the popover is detected to be over a light / white surface. */
  const [onLightBg, setOnLightBg] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setIsClosing(false);
    } else if (visible) {
      setIsClosing(true);
      const t = setTimeout(() => {
        setVisible(false);
        setIsClosing(false);
        setOnLightBg(false); // reset so next open re-detects
      }, 150);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Detect the background after the popover is positioned in the DOM.
  // requestAnimationFrame defers until after the browser has committed
  // the layout, giving accurate getBoundingClientRect values and avoiding
  // a one-frame flash of the wrong style.
  useEffect(() => {
    if (!open || !visible) return;
    const raf = requestAnimationFrame(() => {
      if (!ref.current) return;
      setOnLightBg(
        detectLightBackground(ref.current, anchorRef.current ?? null),
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [open, visible, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Clicking INTO the Preview <iframe> (or switching apps) steals focus
    // without ever firing a mousedown in the parent document — so the outside-
    // click handler alone would leave the popover stuck open. Window blur
    // catches that case so "click outside to close" works over the iframe too.
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [open, onClose, anchorRef]);

  if (!visible || !anchorRef.current) return null;

  const rect = anchorRef.current.getBoundingClientRect();
  const popoverWidth = width === "anchor" ? rect.width : width;

  const placeAbove = rect.top > window.innerHeight - rect.bottom;
  const isLeftSide = rect.left + rect.width / 2 < window.innerWidth / 2;

  const style: React.CSSProperties = {
    position: "fixed",
    ...(isLeftSide ? { left: rect.left } : { right: window.innerWidth - rect.right }),
    ...(placeAbove
      ? {
          bottom: attach
            ? window.innerHeight - rect.top
            : window.innerHeight - rect.bottom,
        }
      : { top: attach ? rect.bottom : rect.top }),
    width: popoverWidth,
    maxHeight: "80vh",
    zIndex: 50,
    ...(attach
      ? {}
      : {
          transformOrigin: `${placeAbove ? "bottom" : "top"} ${isLeftSide ? "left" : "right"}`,
        }),
  };

  const shadow = placeAbove
    ? "shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_-8px_40px_rgba(0,0,0,0.5)]"
    : "shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_8px_40px_rgba(0,0,0,0.5)]";

  const enterAnim = attach
    ? placeAbove
      ? "animate-reveal-up-in"
      : "animate-reveal-down-in"
    : "animate-morph-in";
  const exitAnim = attach
    ? placeAbove
      ? "animate-reveal-up-out"
      : "animate-reveal-down-out"
    : "animate-morph-out";

  const attachChrome = attach
    ? placeAbove
      ? "rounded-b-none border-b-0"
      : "rounded-t-none border-t-0"
    : "";

  // Chrome switches between two modes:
  //
  //   glass  — translucent white/10 + heavy blur. Looks great on AKA's dark
  //            purple surfaces. Text: white at various opacities.
  //
  //   solid  — opaque dark AKA card (#0e0820 ≈ AKA's darkest purple at 95%).
  //            Used automatically when the popover sits over a light surface
  //            (e.g. a white webpage in the Preview pane). Ensures every
  //            text-white* class stays legible regardless of what's behind the
  //            popover.
  const glassChrome = `border-white/15 bg-white/10 backdrop-blur-2xl`;
  const solidChrome = `border-white/20 bg-[#0e0820]/95 backdrop-blur-xl`;

  const chrome = onLightBg ? solidChrome : glassChrome;

  const defaultClass = attach
    ? `flex flex-col rounded-2xl border ${chrome} ${shadow} overflow-hidden ${attachChrome}`
    : `flex w-72 flex-col rounded-2xl border ${chrome} ${shadow} overflow-hidden`;

  // Close-button adapts its hover state to match the chrome mode so it stays
  // readable in both light and dark ambient contexts.
  const closeBtnClass = onLightBg
    ? "flex w-full items-center justify-center rounded-xl bg-white/8 px-3 py-2 text-sm text-white/70 transition-all hover:bg-white/15 hover:text-white active:scale-[0.97]"
    : "flex w-full items-center justify-center rounded-xl bg-white/10 px-3 py-2 text-sm text-white/60 transition-all hover:bg-white/20 hover:text-white active:scale-[0.97]";

  return createPortal(
    <div
      ref={ref}
      style={style}
      className={[
        className ?? defaultClass,
        isClosing ? exitAnim : enterAnim,
      ].join(" ")}
    >
      {header ? (
        <>
          <div className="shrink-0">{header}</div>
          <div className="h-px bg-white/10" />
        </>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
      <div className="shrink-0 px-3 pb-3 pt-1">
        <button onClick={onClose} className={closeBtnClass}>
          Close Modal
        </button>
      </div>
    </div>,
    document.body,
  );
}
