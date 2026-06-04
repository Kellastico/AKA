import { Plus } from "@phosphor-icons/react";
import { ProjectPill } from "./ProjectPill";
import { useProjectsStore } from "../stores/use-projects-store";
import { pickProjectFolder } from "../lib/tauri/commands";
import { Tooltip } from "./Tooltip";

export function BottomBar() {
  const projects = useProjectsStore((s) => s.projects);

  const addProject = useProjectsStore((s) => s.addProject);

  async function handleAddProject() {
    try {
      const folder = await pickProjectFolder();
      if (!folder) return;
      await addProject(folder);
    } catch {
      // Not running inside Tauri — no-op in browser preview
    }
  }

  return (
    <footer className="flex h-16 shrink-0 items-center gap-2 px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {projects.map((p) => (
          <ProjectPill key={p.id} project={p} />
        ))}
        <Tooltip label="Add project" side="top">
          <button
            onClick={handleAddProject}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl transition-colors hover:bg-white/20 hover:border-white/30 hover:text-white/80"
            aria-label="Add project"
          >
            <Plus size={16} />
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
