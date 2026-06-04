import { useEffect, useState } from "react";
import {
  CheckCircle,
  Info,
  Trash,
  Warning,
  WarningCircle,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { useRuntimeStore, type Toast } from "./use-runtime-store";

// Per-kind chrome. Frosted-glass surfaces: a translucent color tint over a
// heavy backdrop blur, with a bright edge so the banner still reads distinctly
// over the omnibox/header rather than blending into it.
//   success = green · danger/error = red · warning = amber · info = neutral.
const TOAST_STYLES: Record<Toast["kind"], { box: string; icon: string; Glyph: Icon }> = {
  success: {
    box: "border-emerald-300/50 bg-emerald-400/25",
    icon: "text-emerald-100",
    Glyph: CheckCircle,
  },
  danger: {
    box: "border-rose-300/55 bg-rose-500/25",
    icon: "text-rose-100",
    Glyph: Trash,
  },
  error: {
    box: "border-rose-300/55 bg-rose-500/25",
    icon: "text-rose-100",
    Glyph: WarningCircle,
  },
  warning: {
    box: "border-amber-300/55 bg-amber-400/25",
    icon: "text-amber-100",
    Glyph: Warning,
  },
  info: {
    box: "border-white/25 bg-white/12",
    icon: "text-white/75",
    Glyph: Info,
  },
};

const AUTO_DISMISS_MS = 6000;

/**
 * App-level toasts, anchored TOP-CENTER of the window via `fixed` so they read
 * the same regardless of how many workspace panes are open. Each one slides
 * down from above the top edge on enter and retracts back up on dismiss.
 */
export function RuntimeToasts() {
  const toasts = useRuntimeStore((s) => s.toasts);
  const dismiss = useRuntimeStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[120] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDone={dismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDone,
}: {
  toast: Toast;
  onDone: (id: number) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const style = TOAST_STYLES[toast.kind] ?? TOAST_STYLES.info;
  const Glyph = style.Glyph;

  // Auto-dismiss: trigger the exit animation after a delay; the actual removal
  // happens in onAnimationEnd once the slide-up finishes.
  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      onAnimationEnd={() => {
        if (leaving) onDone(toast.id);
      }}
      className={[
        // Glassmorphic: heavy frosted blur + saturation, a soft top sheen
        // (inset highlight) and a drop shadow for lift. 12×8px padding, min 720px
        // wide, capped to the window on small screens.
        "pointer-events-auto flex min-w-[720px] max-w-[90vw] items-center gap-3 rounded-2xl border px-3 py-2 text-sm font-medium text-white shadow-[0_12px_44px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.35)] backdrop-blur-2xl backdrop-saturate-150",
        leaving ? "animate-toast-out" : "animate-toast-in",
        style.box,
      ].join(" ")}
    >
      <Glyph size={18} weight="fill" className={`shrink-0 ${style.icon}`} />
      <span className="min-w-0 flex-1 break-words">{toast.text}</span>
      <button
        onClick={() => setLeaving(true)}
        className="ml-2 shrink-0 rounded p-0.5 text-white/70 hover:bg-white/15 hover:text-white"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
