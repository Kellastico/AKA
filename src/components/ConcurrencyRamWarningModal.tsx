import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Warning, X } from "@phosphor-icons/react";

/**
 * Big, non-restrictive warning shown right before a memory-limited machine
 * (≤16 GB) starts a second concurrent run on a *different* model. Two distinct
 * models in memory at once is the swap-storm / OOM case.
 *
 * "Non-restrictive" by design: "Yes, I understand" proceeds anyway, "No"
 * backs out. AKA advises, it doesn't forbid. The decision of *whether* to show
 * this lives in `gateForRun` (session-concurrency.ts); this component only
 * renders it.
 */
export function ConcurrencyRamWarningModal({
  open,
  runningModels,
  incomingModelId,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  /** Distinct model(s) already loaded by the running session(s). */
  runningModels: string[];
  /** The model this new run wants to load. */
  incomingModelId: string | null;
  /** "Yes, I understand" — start the run anyway. */
  onConfirm: () => void;
  /** "No" — back out, don't start. */
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const runningLabel =
    runningModels.length > 0 ? runningModels.join(", ") : "another model";

  // Portaled to <body> so `fixed inset-0` covers the real viewport rather than
  // being captured by a transformed ancestor (chat footer / popover), which
  // would clip the modal into a corner.
  return createPortal(
    <div
      data-testid="concurrency-ram-warning"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-2xl border border-amber-400/30 bg-zinc-900/95 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
              <Warning size={18} weight="fill" className="text-amber-300" />
            </span>
            <h2 className="text-sm font-semibold leading-tight">
              This could slow down or crash your computer
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/40 hover:bg-white/10 hover:text-white/80"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-white/70">
          Your machine has limited memory (16&nbsp;GB or less). Running this
          session would load a <strong className="text-white/90">second, different
          model</strong> alongside the one already running — each model takes its
          own full share of RAM. That can make your computer{" "}
          <strong className="text-amber-200">severely slow down or crash</strong>.
        </p>

        <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-white/60">
          <div>
            <span className="text-white/40">Already running:</span>{" "}
            <span className="font-mono text-white/80">{runningLabel}</span>
          </div>
          <div>
            <span className="text-white/40">This session wants:</span>{" "}
            <span className="font-mono text-white/80">
              {incomingModelId ?? "a different model"}
            </span>
          </div>
        </div>

        <p className="mb-4 rounded-lg border border-emerald-400/20 bg-emerald-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-emerald-100/80">
          <strong className="text-emerald-200">Tip:</strong> run your sessions on
          the <strong>same model</strong> — they share one copy in memory, so you
          can run several at once without the slowdown.
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-white/85 hover:bg-white/10"
          >
            No
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-amber-400/90 px-4 py-1.5 text-xs font-semibold text-black hover:bg-amber-300"
          >
            Yes, I understand
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
