import { DownloadSimple, ImageBroken, Warning } from "@phosphor-icons/react";
import { useDragStore } from "../../stores/use-drag-store";

/**
 * Full-chatbox overlay that appears the moment a drag enters the window.
 * Colour-coded by outcome so the user knows what will happen before they drop:
 *
 *   violet  →  all items will be attached (files, folders, or images + vision model)
 *   red     →  all items will be blocked  (images + text-only model)
 *   amber   →  mixed: some will attach, some will be blocked
 *
 * Rendered inside the chatbox `relative` container so it follows the rounded
 * border exactly, blurring the textarea behind it.
 */
export function DropOverlay() {
  const { active, acceptedCount, rejectedCount } = useDragStore();

  if (!active) return null;

  const allRejected = rejectedCount > 0 && acceptedCount === 0;
  const mixed = rejectedCount > 0 && acceptedCount > 0;

  // ── Reject: images dragged, model isn't vision-capable ────────────────────
  if (allRejected) {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 rounded-[inherit] bg-red-950/60 backdrop-blur-sm">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/15 ring-1 ring-inset ring-red-400/25">
          <ImageBroken size={32} weight="duotone" className="text-red-300" />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-[13px] font-semibold text-red-200">
            Vision not supported
          </p>
          <p className="max-w-[200px] text-[11px] leading-snug text-red-300/65">
            Switch to a multimodal model to attach images
          </p>
        </div>
      </div>
    );
  }

  // ── Mixed: some files accepted, some images blocked ───────────────────────
  if (mixed) {
    return (
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 rounded-[inherit] bg-amber-950/55 backdrop-blur-sm">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 ring-1 ring-inset ring-amber-400/25">
          <Warning size={32} weight="duotone" className="text-amber-300" />
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-[13px] font-semibold text-amber-200">
            Partial attachment
          </p>
          <p className="max-w-[220px] text-[11px] leading-snug text-amber-300/65">
            {acceptedCount} {acceptedCount === 1 ? "file" : "files"} will attach
            {" · "}
            {rejectedCount} {rejectedCount === 1 ? "image needs" : "images need"} a vision model
          </p>
        </div>
      </div>
    );
  }

  // ── Accept: everything will be attached ───────────────────────────────────
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 rounded-[inherit] bg-violet-950/55 backdrop-blur-sm">
      <div className="flex h-14 w-14 animate-bounce items-center justify-center rounded-2xl bg-violet-500/15 ring-1 ring-inset ring-violet-400/25">
        <DownloadSimple size={32} weight="duotone" className="text-violet-300" />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-[13px] font-semibold text-violet-200">Drop to attach</p>
        {acceptedCount > 0 && (
          <p className="text-[11px] text-violet-300/65">
            {acceptedCount} {acceptedCount === 1 ? "item" : "items"}
          </p>
        )}
      </div>
    </div>
  );
}
