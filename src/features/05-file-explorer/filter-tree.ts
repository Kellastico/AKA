import type { WalkEntry } from "../../lib/tauri/commands";

/**
 * A node in the pruned tree the search view renders: every match, plus the
 * ancestor folders needed to place it. Folders that only exist to hold a match
 * are marked so the UI can dim them — they are context, not results.
 */
export type FilterNode = {
  name: string;
  relPath: string;
  path: string;
  kind: "dir" | "file";
  /** True when this row matched the query itself (vs. being an ancestor). */
  isMatch: boolean;
  children: FilterNode[];
};

export type FilterResult = {
  roots: FilterNode[];
  /** Total matches found, including any beyond `matchCap`. */
  total: number;
  /** True when `total` exceeded the cap and the tree shows only a prefix. */
  capped: boolean;
};

/** Directories before files, then case-insensitive by name — mirrors `list_dir`. */
function sortNodes(nodes: FilterNode[]): FilterNode[] {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  for (const n of nodes) sortNodes(n.children);
  return nodes;
}

/**
 * Prune a flat project index down to the rows that match `query`, keeping the
 * folder chain above each hit so results stay readable as a tree rather than a
 * wall of full paths.
 *
 * Matching is a case-insensitive substring over the *relative path*, so both
 * `store` and `stores/use-work` narrow the same way, and typing a path segment
 * separator does something useful instead of killing every result.
 */
export function filterWalk(
  entries: WalkEntry[],
  query: string,
  matchCap = 200,
): FilterResult {
  const q = query.trim().toLowerCase();
  if (!q) return { roots: [], total: 0, capped: false };

  const byRelPath = new Map<string, WalkEntry>();
  for (const e of entries) byRelPath.set(e.relPath, e);

  const matches: WalkEntry[] = [];
  for (const e of entries) {
    if (e.relPath.toLowerCase().includes(q)) matches.push(e);
  }
  const total = matches.length;
  const kept = matches.slice(0, matchCap);

  // relPath -> node, so an ancestor shared by many hits is created once.
  const nodes = new Map<string, FilterNode>();
  const roots: FilterNode[] = [];

  const ensure = (relPath: string, isMatch: boolean): FilterNode | null => {
    const existing = nodes.get(relPath);
    if (existing) {
      // A folder can be both an ancestor and a match in its own right; the
      // stronger claim wins so it doesn't render dimmed.
      if (isMatch) existing.isMatch = true;
      return existing;
    }
    const entry = byRelPath.get(relPath);
    if (!entry) return null;
    const node: FilterNode = {
      name: entry.name,
      relPath: entry.relPath,
      path: entry.path,
      kind: entry.kind,
      isMatch,
      children: [],
    };
    nodes.set(relPath, node);

    const slash = relPath.lastIndexOf("/");
    if (slash === -1) {
      roots.push(node);
    } else {
      const parent = ensure(relPath.slice(0, slash), false);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return node;
  };

  for (const m of kept) ensure(m.relPath, true);

  return { roots: sortNodes(roots), total, capped: total > kept.length };
}

/**
 * Depth-first walk of the pruned tree in the order it renders, so keyboard
 * navigation can step through file rows exactly as they appear on screen.
 */
export function flattenFiles(roots: FilterNode[]): FilterNode[] {
  const out: FilterNode[] = [];
  const visit = (n: FilterNode) => {
    if (n.kind === "file") out.push(n);
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
  return out;
}
