import { useEffect, useState } from "react";
import { Lightbulb, X } from "@phosphor-icons/react";

/**
 * Friendly nudge shown when a memory-limited user spins up *another* session
 * while one is already running. It advises reusing the current model across
 * sessions so several can run at once cheaply (one shared copy of the weights)
 * instead of loading a second model and risking a slowdown/crash.
 *
 * Advisory only — "Continue" creates the session regardless. Whether to show
 * this is decided by `adviceForNewSession` (session-concurrency.ts).
 */
export function SameModelAdviceModal({
  open,
  currentModelId,
  onProceed,
  onCancel,
}: {
  open: boolean;
  /** The model already in use that we suggest reusing. */
  currentModelId: string | null;
  /**
   * "Continue" — create the new session anyway. `dontShowAgain` is true when the
   * user ticked the box, so the caller can persist the suppression.
   */
  onProceed: (dontShowAgain: boolean) => void;
  /** "Cancel" — don't create the session. */
  onCancel: () => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  // Reset the checkbox each time the modal reopens.
  useEffect(() => {
    if (open) setDontShowAgain(false);
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-testid="same-model-advice"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-2xl border border-white/15 bg-zinc-900/95 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-500/15">
              <Lightbulb size={18} weight="fill" className="text-sky-300" />
            </span>
            <h2 className="text-sm font-semibold leading-tight">
              Tip: reuse your current model
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
          You already have a session running, and this machine has limited memory
          (16&nbsp;GB or less). You can run more than one session at the same time —
          just keep them on the{" "}
          <strong className="text-white/90">same model</strong>
          {currentModelId ? (
            <>
              {" "}
              (<span className="font-mono text-sky-200">{currentModelId}</span>)
            </>
          ) : null}
          . Sessions on one model share a single copy in memory.
        </p>

        <p className="mb-4 text-xs leading-relaxed text-white/55">
          Choosing a <em>different</em> model for this session loads it separately
          and can slow down or crash your computer.
        </p>

        <div className="flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-white/45 hover:text-white/70">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="h-3.5 w-3.5 accent-sky-400"
            />
            Don&apos;t show this again
          </label>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="rounded-md border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-white/85 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              onClick={() => onProceed(dontShowAgain)}
              className="rounded-md bg-sky-400/90 px-4 py-1.5 text-xs font-semibold text-black hover:bg-sky-300"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
