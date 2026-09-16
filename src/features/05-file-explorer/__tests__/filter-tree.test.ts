import { describe, expect, it } from "vitest";
import { filterWalk, flattenFiles } from "../filter-tree";
import type { WalkEntry } from "../../../lib/tauri/commands";

/** Build a walk index from '/'-separated relative paths; a trailing '/' = dir. */
function index(...relPaths: string[]): WalkEntry[] {
  return relPaths.map((raw) => {
    const isDir = raw.endsWith("/");
    const relPath = isDir ? raw.slice(0, -1) : raw;
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    return {
      name,
      relPath,
      path: `/proj/${relPath}`,
      kind: isDir ? ("dir" as const) : ("file" as const),
    };
  });
}

const PROJECT = index(
  "src/",
  "src/stores/",
  "src/stores/use-workspace-store.ts",
  "src/stores/use-projects-store.ts",
  "src/components/",
  "src/components/Workspace.tsx",
  "src/components/Pane.tsx",
  "README.md",
);

describe("filterWalk", () => {
  it("returns nothing for an empty query", () => {
    const res = filterWalk(PROJECT, "   ");
    expect(res.roots).toEqual([]);
    expect(res.total).toBe(0);
  });

  it("keeps the ancestor chain above each hit", () => {
    const res = filterWalk(PROJECT, "use-workspace");
    expect(res.roots).toHaveLength(1);
    expect(res.roots[0].relPath).toBe("src");
    expect(res.roots[0].children.map((c) => c.relPath)).toEqual(["src/stores"]);
    expect(
      res.roots[0].children[0].children.map((c) => c.relPath),
    ).toEqual(["src/stores/use-workspace-store.ts"]);
  });

  it("marks ancestors as context, not matches", () => {
    const res = filterWalk(PROJECT, "use-workspace");
    const src = res.roots[0];
    expect(src.isMatch).toBe(false);
    expect(src.children[0].isMatch).toBe(false);
    expect(src.children[0].children[0].isMatch).toBe(true);
  });

  it("matches on the relative path, so a path fragment narrows", () => {
    const res = filterWalk(PROJECT, "stores/use-p");
    expect(flattenFiles(res.roots).map((n) => n.relPath)).toEqual([
      "src/stores/use-projects-store.ts",
    ]);
  });

  it("is case-insensitive", () => {
    expect(filterWalk(PROJECT, "WORKSPACE").total).toBe(
      filterWalk(PROJECT, "workspace").total,
    );
  });

  it("creates each shared ancestor exactly once", () => {
    const res = filterWalk(PROJECT, "store");
    // "src" is an ancestor of both hits and of the matching "src/stores" dir,
    // but must appear as a single root.
    expect(res.roots).toHaveLength(1);
    expect(res.roots[0].relPath).toBe("src");
  });

  it("promotes an ancestor that matches in its own right", () => {
    const res = filterWalk(PROJECT, "stores");
    const stores = res.roots[0].children[0];
    expect(stores.relPath).toBe("src/stores");
    expect(stores.isMatch).toBe(true);
  });

  it("sorts directories before files, then by name", () => {
    const res = filterWalk(PROJECT, "s");
    expect(res.roots[0].children.map((c) => c.name)).toEqual([
      "components",
      "stores",
    ]);
  });

  it("keeps root-level files as roots", () => {
    const res = filterWalk(PROJECT, "README");
    expect(res.roots.map((r) => r.relPath)).toEqual(["README.md"]);
    expect(res.roots[0].kind).toBe("file");
  });

  it("caps matches and reports that it did", () => {
    const many = index(...Array.from({ length: 30 }, (_, i) => `f${i}-hit.ts`));
    const res = filterWalk(many, "hit", 10);
    expect(res.total).toBe(30);
    expect(res.capped).toBe(true);
    expect(flattenFiles(res.roots)).toHaveLength(10);
  });

  it("does not report a cap when everything fits", () => {
    const res = filterWalk(PROJECT, "README", 10);
    expect(res.capped).toBe(false);
  });

  it("survives an index missing an ancestor entry", () => {
    // A walk truncated mid-tree can hand us a file whose parent dir never made
    // it into the index; the row must still be reachable rather than dropped.
    const orphan = index("deep/nested/leaf.ts").filter(
      (e) => e.relPath === "deep/nested/leaf.ts",
    );
    const res = filterWalk(orphan, "leaf");
    expect(flattenFiles(res.roots).map((n) => n.relPath)).toEqual([
      "deep/nested/leaf.ts",
    ]);
  });
});

describe("flattenFiles", () => {
  it("yields file rows in render order and skips folders", () => {
    const res = filterWalk(PROJECT, "s");
    const names = flattenFiles(res.roots).map((n) => n.name);
    expect(names).toEqual([
      "Pane.tsx",
      "Workspace.tsx",
      "use-projects-store.ts",
      "use-workspace-store.ts",
    ]);
  });
});
