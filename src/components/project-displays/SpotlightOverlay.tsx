import { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass, ChatCircle, Clock, Plus } from "@phosphor-icons/react";
import { Project, useProjectsStore } from "../../stores/use-projects-store";

export function SpotlightOverlay({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setActive = useProjectsStore((s) => s.setActiveProject);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    setQuery("");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return project.sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [project.sessions, query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-32"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-2xl border border-pill-stroke bg-pill shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-ink/10 px-4 py-3">
          <MagnifyingGlass size={16} className="text-ink/40" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search sessions in ${project.name}…`}
            className="w-full bg-transparent text-sm placeholder:text-ink/40 focus:outline-none"
          />
          <kbd className="rounded border border-ink/15 px-1.5 py-0.5 text-[10px] text-ink/40">
            esc
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-ink/40">
              No matches
            </div>
          )}
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setActive(project.id);
                onClose();
              }}
              className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-ink/5"
            >
              <ChatCircle size={16} className="shrink-0 text-ink/50" />
              <span className="flex-1 truncate">{s.title}</span>
              <span className="flex items-center gap-1 text-[11px] text-ink/40">
                <Clock size={12} />
                {s.updatedAt}
              </span>
            </button>
          ))}
          <div className="my-1 h-px bg-ink/10" />
          <button
            onClick={() => {
              setActive(project.id);
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm hover:bg-ink/5"
          >
            <Plus size={16} className="text-ink/50" />
            New session
          </button>
        </div>
      </div>
    </div>
  );
}
