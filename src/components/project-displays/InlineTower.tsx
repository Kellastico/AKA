import { useRef, RefObject } from "react";
import { ChatCircle, Plus } from "@phosphor-icons/react";
import { Project, useProjectsStore } from "../../stores/use-projects-store";
import { useDismiss } from "../../lib/use-dismiss";

export function InlineTower({
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
  const setActive = useProjectsStore((s) => s.setActiveProject);
  useDismiss(open, onClose, [ref, anchorRef]);

  if (!open || !anchorRef.current) return null;

  const rect = anchorRef.current.getBoundingClientRect();

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: rect.left + rect.width / 2,
        bottom: window.innerHeight - rect.top + 8,
        transform: "translateX(-50%)",
        zIndex: 40,
      }}
      className="flex flex-col-reverse items-stretch gap-1"
    >
      <button
        onClick={() => {
          setActive(project.id);
          onClose();
        }}
        className="inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-pill-stroke bg-pill px-4 text-xs hover:bg-[#dad9d6]"
      >
        <Plus size={12} />
        New session
      </button>
      {project.sessions.map((s) => (
        <button
          key={s.id}
          onClick={() => {
            setActive(project.id);
            onClose();
          }}
          className="inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-pill-stroke bg-pill px-4 text-xs hover:bg-[#dad9d6]"
        >
          <ChatCircle size={12} className="text-ink/50" />
          <span className="max-w-[180px] truncate">{s.title}</span>
          <span className="text-[10px] text-ink/40">{s.updatedAt}</span>
        </button>
      ))}
    </div>
  );
}
