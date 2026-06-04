import { useCallback, useEffect, useState } from "react";
import {
  CaretRight,
  Folder,
  FolderOpen,
  FileTs,
  FileJs,
  FileCode,
  FileCss,
  File,
  GitBranch,
} from "@phosphor-icons/react";
import { listDir, countLines, type DirEntry } from "../../lib/tauri/commands";
import { useProjectsStore } from "../../stores/use-projects-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";

function fmtLines(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fileIcon(name: string) {
  const cls = "shrink-0";
  if (name.endsWith(".tsx") || name.endsWith(".jsx"))
    return <FileTs size={13} className={`${cls} text-blue-400`} />;
  if (name.endsWith(".ts") || name.endsWith(".js"))
    return <FileJs size={13} className={`${cls} text-yellow-400`} />;
  if (name.endsWith(".rs"))
    return <FileCode size={13} className={`${cls} text-orange-400`} />;
  if (name.endsWith(".css"))
    return <FileCss size={13} className={`${cls} text-sky-400`} />;
  return <File size={13} className={`${cls} text-white/35`} />;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

type DirState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  entries: DirEntry[];
};

function DirRow({
  entry,
  depth,
  selectedPath,
  cache,
  setCache,
  lineCounts,
  setLineCounts,
  onSelect,
}: {
  entry: DirEntry;
  depth: number;
  selectedPath: string | null;
  cache: Record<string, DirState>;
  setCache: React.Dispatch<React.SetStateAction<Record<string, DirState>>>;
  lineCounts: Record<string, number | null>;
  setLineCounts: React.Dispatch<React.SetStateAction<Record<string, number | null>>>;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const state = cache[entry.path];

  useEffect(() => {
    if (entry.path in lineCounts) return;
    setLineCounts((c) => ({ ...c, [entry.path]: null }));
    void countLines(entry.path)
      .then((n) => setLineCounts((c) => ({ ...c, [entry.path]: n })))
      .catch(() => setLineCounts((c) => ({ ...c, [entry.path]: 0 })));
  }, [entry.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineCount = lineCounts[entry.path];

  const load = useCallback(async () => {
    if (state?.loaded || state?.loading) return;
    setCache((c) => ({
      ...c,
      [entry.path]: { loaded: false, loading: true, error: null, entries: [] },
    }));
    try {
      const entries = await listDir(entry.path);
      setCache((c) => ({
        ...c,
        [entry.path]: { loaded: true, loading: false, error: null, entries },
      }));
    } catch (err) {
      setCache((c) => ({
        ...c,
        [entry.path]: {
          loaded: true,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          entries: [],
        },
      }));
    }
  }, [entry.path, state?.loaded, state?.loading, setCache]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  const indent = depth * 12;

  return (
    <div>
      <button
        onClick={toggle}
        className="group flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left hover:bg-white/6"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        <CaretRight
          size={10}
          className={`shrink-0 text-white/30 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        {open ? (
          <FolderOpen size={13} className="shrink-0 text-amber-300/80" weight="fill" />
        ) : (
          <Folder size={13} className="shrink-0 text-amber-300/60" weight="fill" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-white/70">{entry.name}</span>
        {lineCount != null && (
          <span className="ml-2 shrink-0 select-none text-[10px] tabular-nums text-white/25">
            {fmtLines(lineCount)}
          </span>
        )}
      </button>
      {open && (
        <div>
          {state?.loading && (
            <div
              className="px-2 py-[3px] text-[10px] italic text-white/30"
              style={{ paddingLeft: `${8 + indent + 14}px` }}
            >
              loading…
            </div>
          )}
          {state?.error && (
            <div
              className="px-2 py-[3px] text-[10px] text-rose-300/70"
              style={{ paddingLeft: `${8 + indent + 14}px` }}
            >
              {state.error}
            </div>
          )}
          {state?.entries.map((child) =>
            child.kind === "dir" ? (
              <DirRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                cache={cache}
                setCache={setCache}
                lineCounts={lineCounts}
                setLineCounts={setLineCounts}
                onSelect={onSelect}
              />
            ) : (
              <FileRow
                key={child.path}
                entry={child}
                depth={depth + 1}
                isSelected={selectedPath === child.path}
                lineCounts={lineCounts}
                setLineCounts={setLineCounts}
                onSelect={onSelect}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({
  entry,
  depth,
  isSelected,
  lineCounts,
  setLineCounts,
  onSelect,
}: {
  entry: DirEntry;
  depth: number;
  isSelected: boolean;
  lineCounts: Record<string, number | null>;
  setLineCounts: React.Dispatch<React.SetStateAction<Record<string, number | null>>>;
  onSelect: (path: string) => void;
}) {
  useEffect(() => {
    if (entry.path in lineCounts) return;
    setLineCounts((c) => ({ ...c, [entry.path]: null }));
    void countLines(entry.path)
      .then((n) => setLineCounts((c) => ({ ...c, [entry.path]: n })))
      .catch(() => setLineCounts((c) => ({ ...c, [entry.path]: 0 })));
  }, [entry.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineCount = lineCounts[entry.path];
  const indent = depth * 12;
  return (
    <button
      onClick={() => onSelect(entry.path)}
      className={[
        "flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left",
        isSelected
          ? "bg-white/10 text-white/90"
          : "text-white/55 hover:bg-white/6 hover:text-white/80",
      ].join(" ")}
      style={{ paddingLeft: `${8 + indent + 14}px` }}
    >
      {fileIcon(entry.name)}
      <span className="min-w-0 flex-1 truncate text-[11px]">{entry.name}</span>
      {lineCount != null && (
        <span className="ml-2 shrink-0 select-none text-[10px] tabular-nums text-white/25">
          {fmtLines(lineCount)}
        </span>
      )}
    </button>
  );
}

export function FilesContent() {
  const projectPath = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const openFileInActivePane = useWorkspaceStore(
    (s) => s.openFileInActivePane,
  );

  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, DirState>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [lineCounts, setLineCounts] = useState<Record<string, number | null>>({});

  useEffect(() => {
    setRootEntries(null);
    setRootError(null);
    setCache({});
    setLineCounts({});
    if (!projectPath) return;
    let alive = true;
    listDir(projectPath)
      .then((entries) => {
        if (alive) setRootEntries(entries);
      })
      .catch((err) => {
        if (alive)
          setRootError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  const handleSelect = (path: string) => {
    setSelectedPath(path);
    openFileInActivePane(path);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/8 px-3 py-1.5">
        <GitBranch size={11} className="shrink-0 text-white/30" />
        <span className="truncate text-[10px] text-white/35">
          {projectPath ? basename(projectPath) : "no project"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!projectPath && (
          <div className="px-3 py-2 text-[11px] text-white/35">
            Pick a project folder from the bottom rail.
          </div>
        )}
        {rootError && (
          <div className="px-3 py-2 text-[11px] text-rose-300/70">
            {rootError}
          </div>
        )}
        {projectPath &&
          rootEntries === null &&
          !rootError && (
            <div className="px-3 py-2 text-[11px] italic text-white/30">
              loading…
            </div>
          )}
        {rootEntries?.map((entry) =>
          entry.kind === "dir" ? (
            <DirRow
              key={entry.path}
              entry={entry}
              depth={0}
              selectedPath={selectedPath}
              cache={cache}
              setCache={setCache}
              lineCounts={lineCounts}
              setLineCounts={setLineCounts}
              onSelect={handleSelect}
            />
          ) : (
            <FileRow
              key={entry.path}
              entry={entry}
              depth={0}
              isSelected={selectedPath === entry.path}
              lineCounts={lineCounts}
              setLineCounts={setLineCounts}
              onSelect={handleSelect}
            />
          ),
        )}
      </div>
    </div>
  );
}
