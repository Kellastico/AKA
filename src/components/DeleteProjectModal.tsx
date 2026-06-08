import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Trash, Warning } from "@phosphor-icons/react";

/**
 * Full-screen warning shown before a project is removed from AKA. Deliberately
 * a takeover (not a small popover card) so the destructive intent is
 * unmistakable — the user can't dismiss it by reflex while skimming the
 * session list.
 *
 * Important framing: removing a project only forgets it *inside AKA* (the entry,
 * its sessions, and chat history). It never touches the files on disk. The copy
 * says so explicitly to keep this from reading as "delete my code".
 *
 * "Don't show this again" persists via `suppressDeleteProjectWarning`
 * (use-prefs-store); when set, callers delete straight away and skip this.
 *
 * Portaled to <body> so `fixed inset-0` covers the real viewport instead of
 * being clipped inside a transformed ancestor (the project Popover).
 */
export function DeleteProjectModal({
  open,
  projectName,
  projectPath,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  projectName: string;
  projectPath: string;
  /** "Delete" — `dontShowAgain` is true when the user ticked the box. */
  onConfirm: (dontShowAgain: boolean) => void;
  /** "Cancel" / Escape — leave the project alone. */
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

  return createPortal(
    <div
      data-testid="delete-project-warning"
      role="dialog"
      aria-modal="true"
      aria-label="Delete project from AKA"
      className="fixed inset-0 z-[130] flex flex-col items-center justify-center bg-[#0b0614]/95 px-6 backdrop-blur-md"
    >
      <div className="flex w-full max-w-lg flex-col items-center text-center text-white">
        <span className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-rose-500/15 ring-1 ring-rose-400/30">
          <Warning size={40} weight="fill" className="text-rose-300" />
        </span>

        <h1 className="text-2xl font-semibold leading-tight">
          Delete this project from AKA?
        </h1>

        <p className="mt-3 text-sm leading-relaxed text-white/70">
          AKA will forget this project along with all of its sessions and chat
          history. This can&apos;t be undone.
        </p>

        <p className="mt-2 text-sm leading-relaxed text-white/55">
          Your files stay safe — nothing on disk is deleted. You can always add
          the folder back later.
        </p>

        <div className="mt-6 w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left">
          <div className="truncate text-sm font-medium text-white/90">
            {projectName}
          </div>
          <div className="truncate pt-0.5 font-mono text-[11px] text-white/45">
            {projectPath}
          </div>
        </div>

        <label className="mt-6 flex cursor-pointer items-center gap-2 text-xs text-white/45 hover:text-white/70">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="h-3.5 w-3.5 accent-rose-400"
          />
          Don&apos;t show this again
        </label>

        <div className="mt-6 flex w-full items-center justify-center gap-3">
          <button
            onClick={onCancel}
            className="rounded-lg border border-white/15 bg-white/5 px-6 py-2.5 text-sm font-medium text-white/85 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(dontShowAgain)}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-500/90 px-6 py-2.5 text-sm font-semibold text-white hover:bg-rose-400"
          >
            <Trash size={16} weight="fill" />
            Delete project
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
