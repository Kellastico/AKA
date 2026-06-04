import { listDir, readTextFile } from "./tauri/commands";

export type DetectedDevServer = {
  cmd: string;
  args: string[];
  /** Human-readable explanation for the user — shown next to the auto-detect button. */
  reason: string;
};

/**
 * Inspect the project root and pick a sensible dev-server command. Used by
 * the first-run prompt so users with little-to-no coding experience never
 * have to guess the right invocation for their project type.
 *
 * Ordered by specificity: Node first (because the inferred npm script is
 * authoritative), then language-specific runtimes, then the static-HTML
 * Python fallback that works for any folder with an index.html.
 *
 * Returns `null` when nothing matches — the modal then just leaves the
 * user typing their own command, with the original placeholder.
 */
export async function detectDevServer(
  projectPath: string,
): Promise<DetectedDevServer | null> {
  let entries: Awaited<ReturnType<typeof listDir>>;
  try {
    entries = await listDir(projectPath);
  } catch {
    return null;
  }
  const names = new Set(entries.map((e) => e.name));

  // ---- Node ----
  // Read scripts so we pick "dev" / "start" / "serve" intelligently rather
  // than blindly assuming the project has a "dev" script.
  if (names.has("package.json")) {
    try {
      const { contents } = await readTextFile(
        `${projectPath}/package.json`,
      );
      const pkg = JSON.parse(contents) as {
        scripts?: Record<string, string>;
        name?: string;
      };
      const scripts = pkg.scripts ?? {};
      for (const candidate of ["dev", "start", "serve", "develop"]) {
        if (scripts[candidate]) {
          return {
            cmd: "npm",
            args: ["run", candidate],
            reason: `package.json — running "${candidate}" script`,
          };
        }
      }
    } catch {
      // fall through — we'll still default to npm run dev so the user
      // sees a useful error rather than nothing happening.
    }
    return {
      cmd: "npm",
      args: ["run", "dev"],
      reason: "package.json with no recognized script — defaulting to npm run dev",
    };
  }

  // ---- Python frameworks ----
  // `-u` forces unbuffered stdio so server logs flush in real time. Without
  // it Python block-buffers when stdio is piped (as we do here) and the
  // Preview pane hangs waiting for output that's stuck in CPython's buffer.
  if (names.has("manage.py")) {
    return {
      cmd: "python3",
      args: ["-u", "manage.py", "runserver"],
      reason: "Django project (manage.py)",
    };
  }
  if (names.has("app.py") || names.has("application.py")) {
    return {
      cmd: "python3",
      args: ["-u", names.has("app.py") ? "app.py" : "application.py"],
      reason: "Python entry script",
    };
  }

  // ---- Ruby ----
  if (names.has("Gemfile")) {
    return {
      cmd: "bundle",
      args: ["exec", "rails", "server"],
      reason: "Ruby/Rails (Gemfile)",
    };
  }

  // ---- Go / Rust ----
  if (names.has("go.mod")) {
    return { cmd: "go", args: ["run", "."], reason: "Go module (go.mod)" };
  }
  if (names.has("Cargo.toml")) {
    return { cmd: "cargo", args: ["run"], reason: "Rust crate (Cargo.toml)" };
  }

  // ---- Static HTML fallback ----
  // The catch-all for beginner projects: a folder with index.html. Python's
  // http.server is on every macOS / most Linux installs out of the box.
  //
  // `-u` so logs flush immediately (avoids the buffering trap); `--bind
  // 127.0.0.1` so the server announces an IPv4 URL the WKWebView can load
  // reliably on machines with IPv6 disabled.
  if (names.has("index.html")) {
    return {
      cmd: "python3",
      args: ["-u", "-m", "http.server", "8000", "--bind", "127.0.0.1"],
      reason: "Static HTML — Python web server on port 8000 (localhost)",
    };
  }

  return null;
}
