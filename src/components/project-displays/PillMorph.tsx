import { RefObject } from "react";
import { Folder } from "@phosphor-icons/react";
import { Project } from "../../stores/use-projects-store";
import { Popover } from "../Popover";
import { SessionList } from "./SessionList";

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
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      header={
        <div className="px-5 pt-3 pb-2">
          <div className="flex items-center gap-2 text-sm">
            <Folder size={16} />
            <span className="truncate font-medium">{project.name}</span>
          </div>
          <div className="truncate pt-1 text-[11px] text-white/40">
            {project.path}
          </div>
        </div>
      }
    >
      <SessionList project={project} onPick={onClose} />
    </Popover>
  );
}
