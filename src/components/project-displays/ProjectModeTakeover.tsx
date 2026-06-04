import { useEffect } from "react";
import { ChatCircle, Clock, Plus, X } from "@phosphor-icons/react";
import { Tooltip } from "../Tooltip";
import { useProjectsStore } from "../../stores/use-projects-store";

export function ProjectModeTakeover() {
  const takeoverId = useProjectsStore((s) => s.takeoverProjectId);
  const project = useProjectsStore((s) =>
    s.projects.find((p) => p.id === takeoverId)
  );
  const setTakeover = useProjectsStore((s) => s.setTakeover);
  const setActive = useProjectsStore((s) => s.setActiveProject);

  useEffect(() => {
    if (!takeoverId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTakeover(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [takeoverId, setTakeover]);

  if (!project) return null;

  const close = () => setTakeover(null);
  const pickSession = (sessionId: string) => {
    setActive(project.id);
    close();
    void sessionId;
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-shell px-6 pt-4 pb-4">
      <header className="mb-4 flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-ink/40">
            Project
          </div>
          <h1 className="text-xl font-medium">{project.name}</h1>
          <div className="text-xs text-ink/40">{project.path}</div>
        </div>
        <Tooltip label="Exit project mode" side="bottom">
          <button
            onClick={close}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-pill-stroke bg-pill text-ink/60 hover:bg-[#dad9d6]"
            aria-label="Exit project mode"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </header>
      <div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        <button
          onClick={() => pickSession("new")}
          className="flex h-32 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-pill-stroke bg-shell text-sm text-ink/50 hover:bg-pill"
        >
          <Plus size={20} />
          New session
        </button>
        {project.sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => pickSession(s.id)}
            className="flex h-32 flex-col justify-between rounded-2xl border border-pill-stroke bg-panel p-4 text-left hover:bg-[#d4d3d0]"
          >
            <div className="flex items-start gap-2">
              <ChatCircle size={18} className="mt-0.5 shrink-0 text-ink/50" />
              <span className="truncate text-sm font-medium">{s.title}</span>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-ink/40">
              <Clock size={12} />
              {s.updatedAt}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
