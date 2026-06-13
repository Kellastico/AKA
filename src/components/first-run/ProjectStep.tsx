import { useState } from "react";
import { Check, CircleNotch, Folder, FolderOpen, Sparkle } from "@phosphor-icons/react";
import { useProjectsStore } from "../../stores/use-projects-store";
import { useFirstRunStore } from "../../stores/use-first-run-store";
import { pickProjectFolder } from "../../lib/tauri/commands";

/**
 * Final step. The user picks (or has already picked) a folder; we start a
 * fresh session in it and call `complete()` which closes the wizard. The
 * next thing they see is the actual chat input, already pointed at their
 * project and ready for a prompt.
 */
export function ProjectStep() {
  const projects = useProjectsStore((s) => s.projects);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const addProject = useProjectsStore((s) => s.addProject);
  const startNewSession = useProjectsStore((s) => s.startNewSession);
  const activateSession = useProjectsStore((s) => s.activateSession);

  const complete = useFirstRunStore((s) => s.complete);

  const [busy, setBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  // The most-recently-added project, which is also what `addProject`
  // auto-activates. Used to show the "All set" confirmation card.
  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? projects[projects.length - 1];

  const handlePick = async () => {
    setBusy(true);
    setPickError(null);
    try {
      const folder = await pickProjectFolder();
      if (!folder) {
        setBusy(false);
        return;
      }
      await addProject(folder);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async () => {
    if (!activeProject) return;
    setBusy(true);
    // Land the user directly in chat — no extra "click the project pill to
    // open the sessions popover" hop. addProject already created a fresh
    // session, so reuse it; only fall back to creating one for projects
    // imported before that behavior existed.
    if (activeProject.sessions.length > 0) {
      activateSession(activeProject.id, activeProject.sessions[0].id);
    } else {
      await startNewSession(activeProject.id);
    }
    await complete();
  };

  return (
    <div className="flex flex-col gap-6">
      <Header
        title="Open your first project"
        subtitle="Pick a folder to work in. AKA stays sandboxed to this folder — agents can only read and write files inside it."
      />

      {activeProject ? (
        <ReadyCard
          name={activeProject.name}
          path={activeProject.path}
          onChange={() => void handlePick()}
          changeBusy={busy}
        />
      ) : (
        <PickCard onPick={() => void handlePick()} busy={busy} />
      )}

      {pickError && (
        <p className="text-[12px] text-red-300/90">{pickError}</p>
      )}

      <p className="text-[11px] text-white/35">
        You can add more projects later from the bottom bar — every project
        gets its own sandbox and its own .äkä/config.json.
      </p>

      <div className="flex items-center justify-end pt-2">
        <button
          onClick={() => void handleFinish()}
          disabled={!activeProject || busy}
          className="inline-flex items-center gap-2 rounded-full bg-fuchsia-500/90 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-fuchsia-400 disabled:bg-white/10 disabled:text-white/35"
        >
          {busy ? (
            <CircleNotch size={13} className="animate-spin" />
          ) : (
            <Sparkle size={13} weight="fill" />
          )}
          Open ÄKÄ
        </button>
      </div>
    </div>
  );
}

function PickCard({ onPick, busy }: { onPick: () => void; busy: boolean }) {
  return (
    <button
      onClick={onPick}
      disabled={busy}
      className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-fuchsia-400/30 bg-fuchsia-500/[0.04] px-6 py-10 text-center transition-colors hover:border-fuchsia-300/50 hover:bg-fuchsia-500/[0.08] disabled:opacity-50"
    >
      <FolderOpen size={28} weight="duotone" className="text-fuchsia-300" />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-white">
          {busy ? "Picking folder…" : "Choose a project folder"}
        </span>
        <span className="text-[12px] text-white/55">
          A folder on your machine — an existing repo, a new directory, anything
        </span>
      </div>
    </button>
  );
}

function ReadyCard({
  name,
  path,
  onChange,
  changeBusy,
}: {
  name: string;
  path: string;
  onChange: () => void;
  changeBusy: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-emerald-400/35 bg-emerald-400/[0.06] px-4 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300">
          <Check size={12} weight="bold" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Folder size={14} weight="fill" className="text-emerald-300/80" />
            <span className="truncate text-sm font-medium text-white">{name}</span>
          </div>
          <span className="truncate font-mono text-[11px] text-white/50">
            {path}
          </span>
        </div>
        <button
          onClick={onChange}
          disabled={changeBusy}
          className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-50"
        >
          Change
        </button>
      </div>
      <span className="text-[12px] text-emerald-200/85">
        Ready. Click Open ÄKÄ to drop into your first session.
      </span>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="text-sm text-white/55">{subtitle}</p>
    </div>
  );
}
