import { useEffect, useRef, useState } from "react";
import {
  FilePlus,
  Folder,
  MagnifyingGlass,
  Warning,
} from "@phosphor-icons/react";
import { useWorkspaceStore } from "../stores/use-workspace-store";
import { useProjectsStore } from "../stores/use-projects-store";
import { useProjectFolders } from "../lib/project-tree";
import { Popover } from "./Popover";
import { readTextFile, writeTextFile } from "../lib/tauri/commands";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";

/**
 * Default body for a freshly-created Context.md. Phrased so the LLM
 * recognises it as a hint file — anything the user writes here is
 * supposed to be advisory context that agents pull in alongside the
 * task prompt.
 */
const CONTEXT_TEMPLATE = `# Context

Notes, conventions, and constraints for agents working in this folder.

-
`;

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function Omnibox() {
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  const extraPanes = useWorkspaceStore((s) => s.extraPanes);
  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const openFileInActivePane = useWorkspaceStore(
    (s) => s.openFileInActivePane,
  );

  const activeProject = useProjectsStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const folders = useProjectFolders();

  // Micro-transition: play omnibox-flash whenever the user opens a session or
  // switches project. Uses direct DOM manipulation + a reflow to restart the
  // animation reliably without re-rendering the input (which would lose focus).
  useEffect(() => {
    if (!activeProjectId && !activeSessionId) return;
    const el = anchorRef.current;
    if (!el) return;
    // Remove → reflow → re-add forces the browser to restart the keyframe.
    el.classList.remove("animate-omnibox-flash");
    void el.offsetWidth;
    el.classList.add("animate-omnibox-flash");
    const cleanup = () => el.classList.remove("animate-omnibox-flash");
    el.addEventListener("animationend", cleanup, { once: true });
    return () => el.removeEventListener("animationend", cleanup);
  }, [activeProjectId, activeSessionId]);

  const activePane = extraPanes.find((p) => p.id === activePaneId) ?? null;
  const activeFilePath =
    activePane?.type === "file" ? (activePane.filePath ?? "") : "";

  const [value, setValue] = useState(activeFilePath);

  useEffect(() => {
    setValue(activeFilePath);
  }, [activeFilePath, activePaneId]);

  // Clear any stale search text when the user switches projects so the box
  // never carries a path from a different repo.
  useEffect(() => {
    setValue("");
  }, [activeProject?.path]);

  const submit = () => {
    if (!activeProject) return;
    const path = value.trim();
    if (!path) return;
    openFileInActivePane(path);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const addContextToFolder = async (folderPath: string) => {
    const path = `${folderPath}/Context.md`;
    setOpen(false);
    setValue(path);
    // Only write the starter template when the file doesn't already exist —
    // otherwise opening an existing Context.md would silently overwrite it.
    try {
      await readTextFile(path);
    } catch {
      try {
        await writeTextFile(path, CONTEXT_TEMPLATE);
      } catch (err) {
        useRuntimeStore.getState().pushToast({
          kind: "error",
          text:
            err instanceof Error
              ? `Couldn't create Context.md: ${err.message}`
              : "Couldn't create Context.md.",
        });
        return;
      }
    }
    openFileInActivePane(path);
  };

  const pickFolder = (folder: { path: string; relPath: string }) => {
    setValue(folder.relPath || folder.path);
    setOpen(false);
    inputRef.current?.focus();
  };

  // Trim trailing slashes and match either an absolute or relative folder.
  const contextTarget = (() => {
    const v = value.trim().replace(/\/$/, "");
    if (!v) return folders[0] ?? null;
    return (
      folders.find((f) => f.path === v || f.relPath === v) ?? folders[0] ?? null
    );
  })();

  const placeholder = activeProject
    ? `Search in ${basename(activeProject.path)}/…`
    : "No project selected — pick one from the bottom bar";

  return (
    <>
      <div
        ref={anchorRef}
        onClick={() => setOpen(true)}
        className={[
          "flex h-9 w-full max-w-[640px] cursor-text items-center gap-2 border bg-white/10 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-3xl transition-[border-radius] duration-150",
          activeProject
            ? "border-white/20"
            : "border-amber-300/35 bg-amber-500/[0.06]",
          open ? "rounded-t-2xl rounded-b-none border-b-white/10" : "rounded-2xl",
        ].join(" ")}
      >
        {activeProject ? (
          <MagnifyingGlass size={14} className="shrink-0 text-white/40" />
        ) : (
          <Warning size={14} weight="fill" className="shrink-0 text-amber-300" />
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={placeholder}
          disabled={!activeProject}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs leading-none text-white/80 placeholder:text-white/40 focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        width="anchor"
        attach
      >
        {!activeProject ? (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-300/30 bg-amber-500/10 px-3 py-3 text-amber-100">
            <Warning
              size={14}
              weight="fill"
              className="mt-0.5 shrink-0 text-amber-300"
            />
            <div className="flex flex-col gap-0.5 text-[12px]">
              <span className="font-medium">No project selected</span>
              <span className="text-[11px] text-amber-100/70">
                Pick a project folder from the bottom rail before searching or
                attaching files.
              </span>
            </div>
          </div>
        ) : folders.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-white/55">
            <Folder size={14} className="shrink-0 text-white/40" />
            Scanning {basename(activeProject.path)}…
          </div>
        ) : (
          <>
            {contextTarget && (
              <button
                onClick={() => void addContextToFolder(contextTarget.path)}
                className="group flex w-full items-center gap-2.5 rounded-2xl border border-amber-200/25 bg-gradient-to-r from-amber-300/15 to-amber-300/5 px-3 py-3 text-left text-sm font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:from-amber-300/25 hover:to-amber-300/10"
              >
                <FilePlus
                  size={16}
                  weight="fill"
                  className="shrink-0 text-amber-300"
                />
                <span className="flex-1 truncate">Add Context.md to Folder</span>
                <span className="truncate font-mono text-[10px] text-amber-100/60 group-hover:text-amber-100/80">
                  {contextTarget.relPath || basename(contextTarget.path)}
                </span>
              </button>
            )}
            <div className="px-1 pt-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              {basename(activeProject.path)} · folders
            </div>
            <div className="flex flex-col gap-1">
              {folders.map((f) => (
                <button
                  key={f.path}
                  onClick={() => pickFolder(f)}
                  className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-white/80 hover:bg-white/10"
                >
                  <Folder
                    size={14}
                    weight="fill"
                    className="shrink-0 text-amber-300/60"
                  />
                  <span className="flex-1 truncate font-mono text-xs">
                    {f.relPath || basename(f.path)}
                  </span>
                  {f.hasContextMd && (
                    <span className="shrink-0 text-[10px] text-white/30">
                      Context.md
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </Popover>
    </>
  );
}
