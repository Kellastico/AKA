import { RefObject } from "react";
import { Folder, Trash } from "@phosphor-icons/react";
import { Project } from "../../stores/use-projects-store";
import { Popover } from "../Popover";
import { Tooltip } from "../Tooltip";
import { SessionList } from "./SessionList";
import { useProjectDeletion } from "./use-project-deletion";

export function PillMorph({
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
  const { requestDelete, modal } = useProjectDeletion(project, onClose);
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      header={
        // `group` so the trash only reveals on hover of the project header —
        // the same hover affordance the session rows use, which keeps this
        // destructive action from sitting a stray tap away from New session.
        <div className="group flex items-start gap-2 px-5 pt-3 pb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm">
              <Folder size={16} className="shrink-0" />
              <span className="truncate font-medium">{project.name}</span>
            </div>
            <div className="truncate pt-1 text-[11px] text-white/40">
              {project.path}
            </div>
          </div>
          <Tooltip label="Delete project">
            <button
              onClick={requestDelete}
              aria-label="Delete project"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white/45 opacity-0 transition-opacity hover:bg-rose-500/20 hover:text-rose-200 group-hover:opacity-100"
            >
              <Trash size={14} />
            </button>
          </Tooltip>
        </div>
      }
    >
      <SessionList project={project} onPick={onClose} />
      {modal}
    </Popover>
  );
}
