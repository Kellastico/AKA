import { useEffect, useRef, useState } from "react";
import { MagnifyingGlass, File, FileTs, FileJs, FileCode, FileCss, FolderOpen } from "@phosphor-icons/react";
import { MOCK_PATHS, filterPaths } from "../lib/mock-file-tree";
import { useFinderStore } from "../stores/use-finder-store";

function fileIcon(name: string) {
  if (name.endsWith(".tsx") || name.endsWith(".jsx"))
    return <FileTs size={13} className="shrink-0 text-blue-400" />;
  if (name.endsWith(".ts") || name.endsWith(".js"))
    return <FileJs size={13} className="shrink-0 text-yellow-400" />;
  if (name.endsWith(".rs"))
    return <FileCode size={13} className="shrink-0 text-orange-400" />;
  if (name.endsWith(".css"))
    return <FileCss size={13} className="shrink-0 text-sky-400" />;
  if (name.endsWith("/") || !name.includes("."))
    return <FolderOpen size={13} className="shrink-0 text-amber-400" />;
  return <File size={13} className="shrink-0 text-white/35" />;
}

function highlight(path: string, query: string) {
  if (!query) return <span className="text-white/80">{path}</span>;
  const idx = path.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <span className="text-white/80">{path}</span>;
  return (
    <>
      <span className="text-white/50">{path.slice(0, idx)}</span>
      <span className="text-white font-medium">{path.slice(idx, idx + query.length)}</span>
      <span className="text-white/50">{path.slice(idx + query.length)}</span>
    </>
  );
}

export function FileFinder() {
  const open = useFinderStore((s) => s.open);
  const closeFinder = useFinderStore((s) => s.closeFinder);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = filterPaths(MOCK_PATHS, query).slice(0, 50);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => { setActiveIdx(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeFinder(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, results.length - 1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
      if (e.key === "Enter")     { if (results[activeIdx]) closeFinder(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, results, activeIdx, closeFinder]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeFinder(); }}
    >
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* panel */}
      <div className="relative w-full max-w-[560px] animate-slide-down-in overflow-hidden rounded-2xl border border-white/15 bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_4px_20px_rgba(0,0,0,0.4)] backdrop-blur-2xl">
        {/* search row */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <MagnifyingGlass size={16} className="shrink-0 text-white/40" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            spellCheck={false}
            className="flex-1 bg-transparent text-sm text-white/90 placeholder:text-white/30 focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-[10px] text-white/30 hover:text-white/60">
              clear
            </button>
          )}
          <kbd className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-white/25">esc</kbd>
        </div>

        {/* results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-white/30">No files match "{query}"</div>
          ) : (
            results.map((path, i) => {
              const name = path.split("/").pop() ?? path;
              const dir  = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
              return (
                <button
                  key={path}
                  onClick={closeFinder}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={[
                    "flex w-full items-center gap-2.5 px-4 py-2 text-left font-mono text-[11px]",
                    i === activeIdx ? "bg-white/10" : "hover:bg-white/5",
                  ].join(" ")}
                >
                  {fileIcon(name)}
                  <span className="flex-1 truncate">
                    {highlight(path, query)}
                  </span>
                  {dir && (
                    <span className="shrink-0 text-[10px] text-white/25 truncate max-w-[140px]">
                      {dir}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* footer hint */}
        <div className="flex items-center justify-between border-t border-white/8 px-4 py-2 text-[10px] text-white/25">
          <span>{results.length} {results.length === 1 ? "file" : "files"}</span>
          <div className="flex items-center gap-3">
            <span><kbd className="font-sans">↑↓</kbd> navigate</span>
            <span><kbd className="font-sans">↵</kbd> open</span>
          </div>
        </div>
      </div>
    </div>
  );
}
