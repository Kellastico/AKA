import { useEffect } from "react";
import {
  FolderOpen,
  Eye,
  ListChecks,
  PencilSimple,
  type Icon,
} from "@phosphor-icons/react";
import {
  useProjectsStore,
  type AccessLevel,
} from "../stores/use-projects-store";

type Option = {
  level: AccessLevel;
  title: string;
  blurb: string;
  Icon: Icon;
};

const OPTIONS: Option[] = [
  {
    level: "read",
    title: "Just Read",
    blurb:
      "The agent can open and read files in this folder. It cannot edit anything.",
    Icon: Eye,
  },
  {
    level: "review",
    title: "Read & Review",
    blurb:
      "The agent reads files and proposes edits as diffs. You approve every change before it touches disk.",
    Icon: ListChecks,
  },
  {
    level: "write",
    title: "Read, Write, & Review",
    blurb:
      "Full access — the agent reads, writes, and reviews its own changes. You can still inspect diffs after the fact.",
    Icon: PencilSimple,
  },
];

/**
 * Shown the first time the user opens a project. Until they pick a permission
 * level, the project's `accessLevel` is undefined and this modal blocks the
 * rest of the workspace.
 */
export function FolderPermissionModal() {
  const activeProject = useProjectsStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  const setAccessLevel = useProjectsStore((s) => s.setAccessLevel);

  const needsConsent =
    activeProject !== null && activeProject.accessLevel === undefined;

  useEffect(() => {
    if (!needsConsent) return;
    // Esc here is intentionally a no-op — the user must make a choice. The
    // modal cannot be dismissed without picking a permission level.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [needsConsent]);

  if (!needsConsent || !activeProject) return null;

  const choose = (level: AccessLevel) => {
    void setAccessLevel(activeProject.id, level);
  };

  return (
    <div
      data-testid="folder-permission-modal"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-sm"
    >
      <div className="w-[520px] max-w-[92vw] rounded-2xl border border-white/15 bg-zinc-900/95 p-6 text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
        <div className="mb-4 flex items-center gap-2.5">
          <FolderOpen size={22} className="text-amber-300" />
          <h2 className="text-base font-medium">Grant folder access</h2>
        </div>
        <p className="mb-1 text-sm text-white/80">
          Your agent needs permission to use this folder:
        </p>
        <p className="mb-5 break-all rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-xs text-white/85">
          {activeProject.path}
        </p>

        <div className="flex flex-col gap-1">
          {OPTIONS.map(({ level, title, blurb, Icon }) => (
            <button
              key={level}
              onClick={() => choose(level)}
              className="group flex items-start gap-3 rounded-xl border border-white/10 bg-white/4 p-3 text-left transition hover:border-amber-300/60 hover:bg-white/8 focus:border-amber-300/80 focus:outline-none"
            >
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/8 text-white/80 group-hover:bg-amber-300/20 group-hover:text-amber-200">
                <Icon size={16} />
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{title}</span>
                <span className="text-[11px] leading-snug text-white/55">
                  {blurb}
                </span>
              </span>
            </button>
          ))}
        </div>

        <p className="mt-4 text-[11px] text-white/40">
          You can change this later from the project's settings.
        </p>
      </div>
    </div>
  );
}
