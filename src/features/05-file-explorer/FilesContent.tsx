import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CaretRight,
  Folder,
  FolderOpen,
  FileTs,
  FileJs,
  FileCode,
  FileCss,
  File,
  FilePlus,
  GitBranch,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import {
  listDir,
  countLines,
  readTextFile,
  walkProject,
  writeTextFile,
  type DirEntry,
  type WalkEntry,
} from "../../lib/tauri/commands";
import { useProjectWatch } from "../../lib/use-project-watch";
import { useProjectFolders } from "../../lib/project-tree";
import { useProjectsStore } from "../../stores/use-projects-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { useRuntimeStore } from "../01-llm-provider/use-runtime-store";
import { useFiletreeStore } from "./use-filetree-store";
import { filterWalk, flattenFiles, type FilterNode } from "./filter-tree";
import { Tooltip } from "../../components/Tooltip";
import { FileContent } from "../../components/pane-content/FileContent";
import { MarkdownPane } from "../../components/pane-content/MarkdownPane";
import { FiletreeSplitter } from "./FiletreeSplitter";
import { splitLayout } from "./split-layout";

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

function fmtLines(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fileIcon(name: string) {
  const cls = "shrink-0";
  if (name.endsWith(".tsx") || name.endsWith(".jsx"))
    return <FileTs size={15} className={`${cls} text-blue-400`} />;
  if (name.endsWith(".ts") || name.endsWith(".js"))
    return <FileJs size={15} className={`${cls} text-yellow-400`} />;
  if (name.endsWith(".rs"))
    return <FileCode size={15} className={`${cls} text-orange-400`} />;
  if (name.endsWith(".css"))
    return <FileCss size={15} className={`${cls} text-sky-400`} />;
  return <File size={15} className={`${cls} text-white/35`} />;
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Bold the matched span inside a row's name so the hit is findable at a glance. */
function highlight(name: string, query: string) {
  const q = query.trim();
  if (!q) return name;
  const idx = name.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return name;
  return (
    <>
      {name.slice(0, idx)}
      <span className="rounded-[3px] bg-amber-300/25 text-white">
        {name.slice(idx, idx + q.length)}
      </span>
      {name.slice(idx + q.length)}
    </>
  );
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

  const indent = depth * 14;

  return (
    <div>
      <button
        onClick={toggle}
        className="group flex w-full items-center gap-2 rounded px-2 py-[5px] text-left hover:bg-white/6"
        style={{ paddingLeft: `${8 + indent}px` }}
      >
        <CaretRight
          size={12}
          className={`shrink-0 text-white/30 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        {open ? (
          <FolderOpen size={15} className="shrink-0 text-amber-300/80" weight="fill" />
        ) : (
          <Folder size={15} className="shrink-0 text-amber-300/60" weight="fill" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] text-white/70">{entry.name}</span>
        {lineCount != null && (
          <span className="ml-2 shrink-0 select-none text-[11px] tabular-nums text-white/25">
            {fmtLines(lineCount)}
          </span>
        )}
      </button>
      {open && (
        <div>
          {state?.loading && (
            <div
              className="px-2 py-[5px] text-[11px] italic text-white/30"
              style={{ paddingLeft: `${8 + indent + 20}px` }}
            >
              loading…
            </div>
          )}
          {state?.error && (
            <div
              className="px-2 py-[5px] text-[11px] text-rose-300/70"
              style={{ paddingLeft: `${8 + indent + 20}px` }}
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
  const indent = depth * 14;
  return (
    <button
      onClick={() => onSelect(entry.path)}
      className={[
        "flex w-full items-center gap-2 rounded px-2 py-[5px] text-left",
        isSelected
          ? "bg-white/10 text-white/90"
          : "text-white/55 hover:bg-white/6 hover:text-white/80",
      ].join(" ")}
      style={{ paddingLeft: `${8 + indent + 20}px` }}
    >
      {fileIcon(entry.name)}
      <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
      {lineCount != null && (
        <span className="ml-2 shrink-0 select-none text-[11px] tabular-nums text-white/25">
          {fmtLines(lineCount)}
        </span>
      )}
    </button>
  );
}

/**
 * One row of the search view. Rendered from the pruned index rather than the
 * lazy cache: everything is already expanded, so there is nothing to toggle —
 * a folder row narrows the query to itself instead.
 */
function FilterRow({
  node,
  depth,
  query,
  activePath,
  selectedPath,
  onSelectFile,
  onDrillFolder,
}: {
  node: FilterNode;
  depth: number;
  query: string;
  activePath: string | null;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onDrillFolder: (relPath: string) => void;
}) {
  const indent = depth * 14;
  const isDir = node.kind === "dir";
  const isActive = !isDir && activePath === node.path;
  const isSelected = !isDir && selectedPath === node.path;

  return (
    <div>
      <button
        onClick={() =>
          isDir ? onDrillFolder(node.relPath) : onSelectFile(node.path)
        }
        data-active={isActive || undefined}
        className={[
          "flex w-full items-center gap-2 rounded px-2 py-[5px] text-left",
          isDir
            ? // Ancestor folders are scaffolding for the hits below them, so
              // they sit back visually unless they matched in their own right.
              node.isMatch
              ? "text-white/70 hover:bg-white/6"
              : "text-white/35 hover:bg-white/6"
            : isActive || isSelected
              ? "bg-white/10 text-white/90"
              : "text-white/55 hover:bg-white/6 hover:text-white/80",
        ].join(" ")}
        style={{ paddingLeft: `${8 + indent + (isDir ? 0 : 20)}px` }}
      >
        {isDir ? (
          <FolderOpen size={15} className="shrink-0 text-amber-300/70" weight="fill" />
        ) : (
          fileIcon(node.name)
        )}
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {highlight(node.name, node.isMatch ? query : "")}
          {isDir && <span className="text-white/20">/</span>}
        </span>
      </button>
      {node.children.map((child) => (
        <FilterRow
          key={child.relPath}
          node={child}
          depth={depth + 1}
          query={query}
          activePath={activePath}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onDrillFolder={onDrillFolder}
        />
      ))}
    </div>
  );
}

/**
 * The tree column: project name, search box, and the tree itself. Owns all the
 * browsing state (query, dir cache, line counts, search index); which file is
 * *open* belongs to the pane, so it arrives as a prop.
 */
function FileTreePanel({
  selectedPath,
  onSelect,
}: {
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const projectPath = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const folders = useProjectFolders();

  const [rootEntries, setRootEntries] = useState<DirEntry[] | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [cache, setCache] = useState<Record<string, DirState>>({});
  const [lineCounts, setLineCounts] = useState<Record<string, number | null>>({});

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Flat project index for the search view, fetched lazily — an unused search
  // box should never cost a full tree walk. `null` means "not fetched yet".
  const [index, setIndex] = useState<WalkEntry[] | null>(null);
  const [indexTruncated, setIndexTruncated] = useState(false);
  const [indexing, setIndexing] = useState(false);
  // Set when the on-disk tree moves while the index is loaded, so the next
  // search refetches instead of matching against a stale snapshot.
  const indexStaleRef = useRef(false);

  // Mirror the dir cache into a ref so the live-refresh callback can read which
  // subdirs are currently expanded without re-subscribing the watcher.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  useEffect(() => {
    setRootEntries(null);
    setRootError(null);
    setCache({});
    setLineCounts({});
    setQuery("");
    setIndex(null);
    setIndexTruncated(false);
    indexStaleRef.current = false;
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

  // Build (or rebuild) the search index the first time it is actually needed.
  const needsIndex = query.trim().length > 0;
  useEffect(() => {
    if (!projectPath || !needsIndex) return;
    if (index !== null && !indexStaleRef.current) return;
    let alive = true;
    setIndexing(true);
    indexStaleRef.current = false;
    walkProject(projectPath)
      .then((res) => {
        if (!alive) return;
        setIndex(res.entries);
        setIndexTruncated(res.truncated);
      })
      .catch(() => {
        // A failed walk leaves an empty index rather than a spinner that never
        // resolves; the row count below then honestly reads "no matches".
        if (alive) {
          setIndex([]);
          setIndexTruncated(false);
        }
      })
      .finally(() => {
        if (alive) setIndexing(false);
      });
    return () => {
      alive = false;
    };
  }, [projectPath, needsIndex, index]);

  // Live tree: when an agent (or the user) creates/edits/deletes anything under
  // the project, re-read the root and every expanded subdir so the pane reflects
  // disk instead of a stale snapshot. Line counts are dropped so visible rows
  // recount — an edited file's size updates too. Debounced via the shared hook.
  const refresh = useCallback(() => {
    if (!projectPath) return;
    listDir(projectPath)
      .then(setRootEntries)
      .catch((err) =>
        setRootError(err instanceof Error ? err.message : String(err)),
      );
    for (const [path, st] of Object.entries(cacheRef.current)) {
      if (!st.loaded) continue;
      listDir(path)
        .then((entries) =>
          setCache((c) => ({
            ...c,
            [path]: { loaded: true, loading: false, error: null, entries },
          })),
        )
        .catch(() => {
          // A deleted expanded dir drops out of its parent's reload above;
          // its stale cache entry is harmless, so swallow the read error.
        });
    }
    setLineCounts({});
    // Don't re-walk on every disk event — a project rebuild would thrash it.
    // Flag it instead and let the next keystroke pay for a fresh index.
    indexStaleRef.current = true;
  }, [projectPath]);

  useProjectWatch(projectPath, refresh);

  const filtered = useMemo(
    () => filterWalk(index ?? [], query),
    [index, query],
  );
  const fileHits = useMemo(() => flattenFiles(filtered.roots), [filtered.roots]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  const handleSelect = (path: string) => onSelect(path);

  const drillFolder = (relPath: string) => {
    setQuery(relPath.endsWith("/") ? relPath : `${relPath}/`);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else inputRef.current?.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(fileHits.length - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const hit = fileHits[activeIdx];
      if (hit) {
        handleSelect(hit.path);
        return;
      }
      // Nothing matched, but the user may have pasted a path the index can't
      // reach (outside the walk bounds, or absolute). Try it verbatim — the
      // file pane surfaces the read error if it isn't real.
      const raw = query.trim();
      if (!raw || !projectPath) return;
      handleSelect(
        raw.startsWith("/") ? raw : `${projectPath.replace(/\/$/, "")}/${raw}`,
      );
    }
  };

  // Same targeting rule the top-bar search box used: the folder the query
  // names, falling back to the project root.
  const contextTarget = (() => {
    const v = query.trim().replace(/\/$/, "");
    if (!v) return folders[0] ?? null;
    return (
      folders.find((f) => f.path === v || f.relPath === v) ?? folders[0] ?? null
    );
  })();

  const addContextToFolder = async (folderPath: string) => {
    const path = `${folderPath}/Context.md`;
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
    handleSelect(path);
  };

  const searching = query.trim().length > 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-2 py-2">
        <div
          className={[
            "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border px-3 transition-colors",
            projectPath
              ? "border-white/12 bg-white/6 focus-within:border-white/25 focus-within:bg-white/10"
              : "border-white/8 bg-white/4",
          ].join(" ")}
        >
          <MagnifyingGlass size={16} className="shrink-0 text-white/35" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            disabled={!projectPath}
            placeholder={
              projectPath
                ? `Search ${basename(projectPath)}/…`
                : "No project selected"
            }
            aria-label="Search files"
            className="min-w-0 flex-1 bg-transparent font-mono text-[14px] leading-none text-white/80 placeholder:text-white/30 focus:outline-none disabled:cursor-not-allowed"
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="shrink-0 rounded-full p-1 text-white/30 hover:bg-white/10 hover:text-white/70"
            >
              <X size={12} weight="bold" />
            </button>
          )}
        </div>
        <Tooltip
          label={
            contextTarget
              ? `Add Context.md to ${contextTarget.relPath || basename(contextTarget.path)}`
              : "Add Context.md"
          }
          side="bottom"
        >
          <button
            onClick={() =>
              contextTarget && void addContextToFolder(contextTarget.path)
            }
            disabled={!contextTarget}
            aria-label="Add Context.md to folder"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-amber-200/20 bg-amber-300/10 px-3 text-amber-100/80 transition-colors hover:border-amber-200/35 hover:bg-amber-300/20 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <FilePlus size={14} weight="fill" className="shrink-0" />
            <span className="text-[12px] font-medium leading-none">md</span>
          </button>
        </Tooltip>
      </div>

      {!searching && (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 py-1.5">
          <GitBranch size={13} className="shrink-0 text-white/30" />
          <span className="truncate text-[12px] text-white/35">
            {projectPath ? basename(projectPath) : "no project"}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!projectPath && (
          <div className="px-3 py-2 text-[13px] text-white/35">
            Pick a project folder from the bottom rail.
          </div>
        )}

        {projectPath && searching ? (
          <>
            {indexing && index === null && (
              <div className="px-3 py-2 text-[13px] italic text-white/30">
                indexing {basename(projectPath)}…
              </div>
            )}
            {index !== null && fileHits.length === 0 && filtered.roots.length === 0 && (
              <div className="px-3 py-2 text-[13px] text-white/35">
                No match for{" "}
                <span className="font-mono text-white/55">{query.trim()}</span>.
                {indexTruncated && (
                  <span className="text-white/25">
                    {" "}
                    The index is capped, so deeply nested files may be missing.
                  </span>
                )}
              </div>
            )}
            {filtered.roots.map((node) => (
              <FilterRow
                key={node.relPath}
                node={node}
                depth={0}
                query={query}
                activePath={fileHits[activeIdx]?.path ?? null}
                selectedPath={selectedPath}
                onSelectFile={handleSelect}
                onDrillFolder={drillFolder}
              />
            ))}
            {filtered.total > 0 && (
              <div className="px-3 pb-2 pt-2 text-[11px] text-white/25">
                {filtered.total} match{filtered.total === 1 ? "" : "es"}
                {filtered.capped && " — showing the first 200"}
                {indexTruncated && " · index capped"}
              </div>
            )}
          </>
        ) : (
          <>
            {rootError && (
              <div className="px-3 py-2 text-[13px] text-rose-300/70">
                {rootError}
              </div>
            )}
            {projectPath && rootEntries === null && !rootError && (
              <div className="px-3 py-2 text-[13px] italic text-white/30">
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
          </>
        )}
      </div>
    </div>
  );
}

const isMarkdownPath = (p?: string | null) =>
  !!p && /\.(md|mdx|markdown)$/i.test(p);

/** Right-hand column with nothing open yet. */
function EmptyViewer() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Folder size={30} className="text-white/20" />
      <div className="text-[13px] text-white/60">Open files appear here</div>
      <div className="max-w-[280px] text-[12px] leading-relaxed text-white/30">
        Pick a file in the tree, or click a file path in the conversation.
      </div>
    </div>
  );
}

/**
 * The filetree pane: tree on the left, the open file on the right.
 *
 * Both columns stay mounted at every width — the one that isn't showing is
 * hidden with `display: none` rather than unmounted, so collapsing the window
 * doesn't throw away expanded folders, the search index, or an unsaved
 * Markdown edit.
 */
export function FilesContent({
  paneId,
  filePath,
}: {
  paneId: string;
  filePath?: string;
}) {
  const openFileInFiletree = useWorkspaceStore((s) => s.openFileInFiletree);
  const closeFiletreeFile = useWorkspaceStore((s) => s.closeFiletreeFile);
  const treeRatio = useFiletreeStore((s) => s.treeRatio);

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Measured in a layout effect so the first paint already knows which layout
  // it is in — starting at 0 would flash the narrow layout on every mount.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasFile = !!filePath;
  const { wide, showTree, showViewer, showDivider, showBack } = splitLayout(
    width,
    hasFile,
  );

  const closeFile = useCallback(
    () => closeFiletreeFile(paneId),
    [closeFiletreeFile, paneId],
  );

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div
        className={showTree ? "flex h-full min-w-0" : "hidden"}
        style={
          wide
            ? {
                flex: `0 0 ${treeRatio * 100}%`,
                transition: dragging ? "none" : "flex-basis 160ms ease",
              }
            : { flex: "1 1 auto" }
        }
      >
        <FileTreePanel
          selectedPath={filePath ?? null}
          onSelect={openFileInFiletree}
        />
      </div>

      {showDivider && (
        <FiletreeSplitter
          containerRef={containerRef}
          onDraggingChange={setDragging}
        />
      )}

      <div className={showViewer ? "flex h-full min-w-0 flex-1" : "hidden"}>
        {!filePath ? (
          <EmptyViewer />
        ) : isMarkdownPath(filePath) ? (
          <MarkdownPane
            filePath={filePath}
            onBack={showBack ? closeFile : undefined}
          />
        ) : (
          <FileContent
            filePath={filePath}
            onBack={showBack ? closeFile : undefined}
          />
        )}
      </div>
    </div>
  );
}
