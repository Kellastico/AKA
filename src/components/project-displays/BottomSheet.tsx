import { useRef, RefObject } from "react";
import { X } from "@phosphor-icons/react";
import { Tooltip } from "../Tooltip";
import { Project } from "../../stores/use-projects-store";
import { useDismiss } from "../../lib/use-dismiss";
import { ProjectHeader, SessionList } from "./SessionList";

export function BottomSheet({
  project,
  open,
  onClose,
  anchorRef,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose, [ref, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="fixed inset-x-0 bottom-16 z-40 mx-auto w-[min(720px,90vw)] rounded-t-2xl border border-pill-stroke bg-pill p-4 shadow-2xl"
      role="dialog"
      aria-label={`${project.name} sessions`}
    >
      <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-ink/20" />
      <div className="flex items-start justify-between">
        <ProjectHeader project={project} />
        <Tooltip label="Close" side="bottom">
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-ink/50 hover:bg-ink/5 hover:text-ink"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
      <div className="my-2 h-px bg-ink/10" />
      <SessionList project={project} onPick={onClose} />
    </div>
  );
}
