import { useEffect, useState } from "react";
import { listDir } from "./tauri/commands";
import { useProjectsStore } from "../stores/use-projects-store";

export type FolderEntry = {
  /** Absolute filesystem path — what we hand to `openFileInActivePane`. */
  path: string;
  /** Path relative to the project root — what we show to the user. */
  relPath: string;
  /** Just the folder's name (last segment). */
  name: string;
  /** True if the folder directly contains a `Context.md` file. */
  hasContextMd: boolean;
};

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".vercel",
  "dist",
  "build",
  "target",
  ".cache",
  ".DS_Store",
]);

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function relativeTo(child: string, root: string): string {
  const c = child.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (c === r) return "";
  if (c.startsWith(r + "/")) return c.slice(r.length + 1);
  return c;
}

/**
 * Walk the project's folder tree breadth-first up to `maxDepth` levels and
 * up to `maxFolders` results. Skips common noise dirs (.git, node_modules,
 * build outputs). Returns folders flagged with whether they already contain
 * a Context.md sibling — used by the Omnibox to suggest where to add one.
 */
export async function scanProjectFolders(
  rootPath: string,
  maxDepth = 3,
  maxFolders = 200,
): Promise<FolderEntry[]> {
  const out: FolderEntry[] = [];
  const queue: { path: string; level: number }[] = [
    { path: rootPath, level: 0 },
  ];

  while (queue.length > 0 && out.length < maxFolders) {
    const { path, level } = queue.shift()!;
    let entries;
    try {
      entries = await listDir(path);
    } catch {
      continue;
    }
    const hasContextMd = entries.some(
      (e) => e.kind === "file" && e.name.toLowerCase() === "context.md",
    );
    out.push({
      path,
      relPath: relativeTo(path, rootPath),
      name: basename(path),
      hasContextMd,
    });
    if (level >= maxDepth) continue;
    for (const e of entries) {
      if (e.kind !== "dir") continue;
      if (IGNORED_NAMES.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name.length > 1) continue;
      queue.push({ path: e.path, level: level + 1 });
    }
  }
  return out;
}

/**
 * React hook that returns the folder list for the currently-active project.
 * Rescans whenever the active project's path changes; empty array when no
 * project is open.
 */
export function useProjectFolders(): FolderEntry[] {
  const rootPath = useProjectsStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const [folders, setFolders] = useState<FolderEntry[]>([]);

  useEffect(() => {
    if (!rootPath) {
      setFolders([]);
      return;
    }
    let alive = true;
    void scanProjectFolders(rootPath).then((next) => {
      if (alive) setFolders(next);
    });
    return () => {
      alive = false;
    };
  }, [rootPath]);

  return folders;
}
