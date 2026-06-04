import { useRef, useState } from "react";
import { Folder, CaretDown } from "@phosphor-icons/react";
import { Pill } from "./Pill";
import { Project, useProjectsStore } from "../stores/use-projects-store";
import { BottomSheet } from "./project-displays/BottomSheet";
import { PillMorph } from "./project-displays/PillMorph";
import { InlineTower } from "./project-displays/InlineTower";
import { SpotlightOverlay } from "./project-displays/SpotlightOverlay";

export function ProjectPill({ project }: { project: Project }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const activeId = useProjectsStore((s) => s.activeProjectId);
  const takeoverId = useProjectsStore((s) => s.takeoverProjectId);
  const setTakeover = useProjectsStore((s) => s.setTakeover);

  const isTakeoverMode = project.displayMode === "takeover";
  const isHighlighted = isTakeoverMode
    ? takeoverId === project.id
    : activeId === project.id;

  const handleClick = () => {
    if (isTakeoverMode) {
      setTakeover(takeoverId === project.id ? null : project.id);
      return;
    }
    // Only open the session picker — the project and its config load only
    // after the user commits to a session (new or existing). Opening the
    // picker alone must not trigger any workspace / runtime side-effects.
    setOpen((v) => !v);
  };

  return (
    <>
      <Pill
        ref={ref}
        active={isHighlighted}
        icon={<Folder size={16} weight="regular" />}
        trailing={
          <CaretDown
            size={12}
            className={[
              "transition-transform",
              isHighlighted ? "text-shell/60" : "text-ink/50",
              open || (isTakeoverMode && takeoverId === project.id)
                ? "rotate-180"
                : "",
            ].join(" ")}
          />
        }
        onClick={handleClick}
      >
        {project.name}
      </Pill>

      {project.displayMode === "sheet" && (
        <BottomSheet
          project={project}
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={ref}
        />
      )}
      {project.displayMode === "morph" && (
        <PillMorph
          project={project}
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={ref}
        />
      )}
      {project.displayMode === "tower" && (
        <InlineTower
          project={project}
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={ref}
        />
      )}
      {project.displayMode === "spotlight" && (
        <SpotlightOverlay
          project={project}
          open={open}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
