import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri command layer the detector reads the project tree through.
// vi.mock is hoisted above the imports, so the factory creates the spies and
// we grab typed handles to them afterwards.
vi.mock("../tauri/commands", () => ({
  listDir: vi.fn(),
  readTextFile: vi.fn(),
}));

import { listDir, readTextFile } from "../tauri/commands";
import { detectDevServer } from "../detect-dev-server";

const mockListDir = vi.mocked(listDir);
const mockReadTextFile = vi.mocked(readTextFile);

/** Build the DirEntry[] listDir returns from a set of file names. */
const entries = (...names: string[]) =>
  names.map((name) => ({ name, path: `/proj/${name}`, kind: "file" as const }));

/** Make readTextFile resolve with the given package.json contents. */
const pkgJson = (obj: unknown) =>
  mockReadTextFile.mockResolvedValue({
    path: "/proj/package.json",
    contents: JSON.stringify(obj),
    mtimeMs: 0,
  });

beforeEach(() => {
  mockListDir.mockReset();
  mockReadTextFile.mockReset();
});

describe("detectDevServer", () => {
  it("runs the first recognized npm script when package.json defines one", async () => {
    mockListDir.mockResolvedValue(entries("package.json"));
    pkgJson({ scripts: { dev: "vite" } });

    const d = await detectDevServer("/proj");
    expect(d?.cmd).toBe("npm");
    expect(d?.args).toEqual(["run", "dev"]);
  });

  it("falls back through dev→start→serve when 'dev' is absent", async () => {
    mockListDir.mockResolvedValue(entries("package.json"));
    pkgJson({ scripts: { serve: "http-server" } });

    const d = await detectDevServer("/proj");
    expect(d?.args).toEqual(["run", "serve"]);
  });

  // The regression this whole change fixes: a static site that happens to carry
  // a package.json with no runnable script must NOT default to `npm run dev`
  // (which dies on "Missing script: dev"). It should serve index.html instead.
  it("prefers the static-HTML server when package.json has no script but index.html exists", async () => {
    mockListDir.mockResolvedValue(entries("package.json", "index.html"));
    pkgJson({ scripts: { build: "tsc" } }); // build only — nothing runnable

    const d = await detectDevServer("/proj");
    expect(d?.cmd).toBe("python3");
    expect(d?.args).toContain("http.server");
    expect(d?.args).toContain("8000");
    expect(d?.reason).toMatch(/index\.html/i);
  });

  it("treats a package.json with no scripts key the same way", async () => {
    mockListDir.mockResolvedValue(entries("package.json", "index.html"));
    pkgJson({ name: "site" }); // no scripts at all

    const d = await detectDevServer("/proj");
    expect(d?.cmd).toBe("python3");
  });

  it("prefers static HTML even when package.json is malformed (parse throws)", async () => {
    mockListDir.mockResolvedValue(entries("package.json", "index.html"));
    mockReadTextFile.mockResolvedValue({
      path: "/proj/package.json",
      contents: "{ this is not json",
      mtimeMs: 0,
    });

    const d = await detectDevServer("/proj");
    expect(d?.cmd).toBe("python3");
  });

  it("still defaults to npm run dev when there is no index.html to fall back to", async () => {
    mockListDir.mockResolvedValue(entries("package.json"));
    pkgJson({ scripts: { build: "tsc" } });

    const d = await detectDevServer("/proj");
    expect(d?.cmd).toBe("npm");
    expect(d?.args).toEqual(["run", "dev"]);
  });

  it("serves a bare folder with only index.html as static HTML", async () => {
    mockListDir.mockResolvedValue(entries("index.html", "style.css"));

    const d = await detectDevServer("/proj");
    expect(d?.cmd).toBe("python3");
    expect(d?.args).toContain("8000");
    expect(mockReadTextFile).not.toHaveBeenCalled();
  });

  it("detects a Django project before reaching the static fallback", async () => {
    mockListDir.mockResolvedValue(entries("manage.py", "index.html"));

    const d = await detectDevServer("/proj");
    expect(d?.cmd).toBe("python3");
    expect(d?.args).toEqual(["-u", "manage.py", "runserver"]);
  });

  it("returns null when nothing matches", async () => {
    mockListDir.mockResolvedValue(entries("notes.txt"));
    expect(await detectDevServer("/proj")).toBeNull();
  });

  it("returns null when the directory can't be listed", async () => {
    mockListDir.mockRejectedValue(new Error("nope"));
    expect(await detectDevServer("/proj")).toBeNull();
  });
});
