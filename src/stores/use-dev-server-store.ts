import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  asAppError,
  killPort,
  startDevServer,
  stopDevServer,
  type AppError,
} from "../lib/tauri/commands";
import { extractBusyPort, isPortInUseError } from "../lib/humanize-error";
import { useWorkspaceStore } from "./use-workspace-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";

export type LogStream = "stdout" | "stderr";
export type LogLine = { id: number; line: string; stream: LogStream };
/**
 * "recovering" is the auto-heal state: the previous launch died on a
 * port-already-in-use error, so AKA is freeing that port and relaunching on
 * the user's behalf. The Preview pane shows a calm "freeing port & restarting"
 * message instead of the scary failure banner while this is in flight.
 */
export type DevStatus = "idle" | "running" | "recovering" | "exited" | "failed";

type LinePayload = { line: string; stream: LogStream };
type DonePayload = { exitCode: number };

const LOG_LIMIT = 2_000;
// `\[::1?\]` matches both `[::1]` (IPv6 localhost) and `[::]` (IPv6 any-addr,
// which is what Python's http.server prints by default).
// The path part excludes `)`, `]`, `>`, `,` so URLs printed wrapped in
// parens — e.g. Python's `(http://127.0.0.1:8000/)` — don't slurp the
// trailing punctuation into the match.
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s)\]>,]*)?/i;
const BARE_LOCALHOST_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))/i;

// How long to wait after a non-zero exit before deciding it's a hard failure.
// The dev server's stdout/stderr are drained by separate tasks on the Rust
// side, so the "Port N is already in use" line can race (and lose to) the
// `dev://done` event. This grace window lets that trailing output land so
// auto-recovery doesn't miss a port conflict that arrived a few ms late.
const FAILURE_SETTLE_MS = 300;

let lineCounter = 0;
const nextId = () => ++lineCounter;

// Monotonic run counter. Every start() (including an auto-recovery restart)
// bumps it; delayed callbacks capture the value at scheduling time and bail if
// it changed, so a late `dev://done` from a superseded run can never act on
// the current one.
let runSeq = 0;

const sniffUrl = (line: string): string | null => {
  const m = line.match(URL_RE);
  if (m) return m[0];
  // Some servers print "Local: localhost:5173" with no scheme.
  const b = line.match(BARE_LOCALHOST_RE);
  if (b) return `http://localhost:${b[1]}`;
  return null;
};

type DevServerState = {
  status: DevStatus;
  log: LogLine[];
  /** First URL we sniffed out of the server output, normalized to http(s)://. */
  detectedUrl: string | null;
  /**
   * Port the *failure* named, sniffed live from the output as it streams
   * (Vite's "Port 5174 is already in use", a Node EADDRINUSE address, …).
   * This is the exact port to free — never guess from the URL bar. Null until
   * a port-conflict line is seen.
   */
  busyPort: number | null;
  exitCode: number | null;
  error: AppError | null;
  /** The project whose dev server we last launched — needed to auto-restart. */
  projectPath: string | null;
  listenersAttached: boolean;
  attachListeners: () => Promise<void>;
  detachListeners: () => void;
  clearLog: () => void;
  start: (projectPath: string) => Promise<void>;
  stop: () => Promise<void>;
  /**
   * Free a held port and (re)start the dev server. Backs the Preview pane's
   * "Free port & restart" button so the component and the auto-recovery path
   * share one implementation.
   */
  freePortAndRestart: (port: number) => Promise<void>;
  /**
   * Tear down completely — stop the running server (if any) and wipe all state
   * back to initial. Called from AppShell on project switch so the new
   * project's Preview pane doesn't inherit the previous project's `detectedUrl`
   * (which would otherwise be re-applied by BrowserContent's auto-fill effect)
   * or its still-running dev server process.
   */
  reset: () => Promise<void>;
};

let unlistenFns: UnlistenFn[] = [];

// Internal flags kept off the public state shape — they coordinate the
// auto-recovery state machine without being read by any component.
//
//   recoveryAttempted — true once we've auto-freed a port + restarted for the
//                        current user-initiated launch, so we never loop.
//   portConflictSeen  — set the instant a port-conflict line streams in, so
//                        the done handler can react without re-scanning.
//   stopping          — set by stop()/reset() so the resulting non-zero exit is
//                        treated as a clean user stop, not a crash.
let recoveryAttempted = false;
let portConflictSeen = false;
let stopping = false;

export const useDevServerStore = create<DevServerState>((set, get) => {
  /**
   * Free `port`, then relaunch the dev server for `projectPath`. Shared by the
   * automatic recovery path and the manual "Free port & restart" button. The
   * `isRecovery` flag keeps the anti-loop guard armed across the restart.
   */
  const freeAndStart = async (
    port: number,
    projectPath: string,
    isRecovery: boolean,
  ): Promise<void> => {
    try {
      await killPort(port);
    } catch {
      // Best-effort — if the kill fails, the restart below will surface the
      // still-in-use error normally (and recoveryAttempted stops a loop).
    }
    await startInternal(projectPath, isRecovery);
  };

  /**
   * The actual launch. `fromRecovery` preserves `recoveryAttempted` so an
   * auto-restart can't trigger a second auto-restart; a normal user start
   * resets it.
   */
  const startInternal = async (
    projectPath: string,
    fromRecovery: boolean,
  ): Promise<void> => {
    await get().attachListeners();
    runSeq++;
    portConflictSeen = false;
    stopping = false;
    if (!fromRecovery) recoveryAttempted = false;
    set({
      status: "running",
      log: [],
      detectedUrl: null,
      busyPort: null,
      exitCode: null,
      error: null,
      projectPath,
    });
    try {
      await startDevServer(projectPath);
    } catch (err) {
      set({ status: "failed", error: asAppError(err) });
    }
  };

  return {
    status: "idle",
    log: [],
    detectedUrl: null,
    busyPort: null,
    exitCode: null,
    error: null,
    projectPath: null,
    listenersAttached: false,

    attachListeners: async () => {
      if (get().listenersAttached) return;
      set({ listenersAttached: true });

      const u1 = await listen<LinePayload>("dev://output", (e) => {
        const { line, stream } = e.payload;
        // Sniff the conflicting port (and remember we saw a conflict) the
        // moment the line arrives — far more reliable than scanning at exit
        // time, when trailing output may still be in flight.
        if (!portConflictSeen && isPortInUseError(line)) portConflictSeen = true;

        let urlJustDetected = false;
        set((s) => {
          const log = [...s.log, { id: nextId(), line, stream }];
          if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
          const sniffed = s.detectedUrl ?? sniffUrl(line);
          if (!s.detectedUrl && sniffed) urlJustDetected = true;
          return {
            log,
            detectedUrl: sniffed,
            busyPort: s.busyPort ?? extractBusyPort(line),
          };
        });

        // A freshly-detected URL means the server is live and serving. Roll
        // any open Preview pane forward so it shows the running app instead
        // of whatever stale frame it had — this is what makes a recovery
        // restart visibly "just work" (the pane URL is unchanged, so the
        // iframe wouldn't reload on its own).
        if (urlJustDetected) {
          useWorkspaceStore.getState().bumpPreviewReload();
        }
      });

      const u2 = await listen<DonePayload>("dev://done", (e) => {
        const code = e.payload.exitCode;

        // User-initiated stop (or project switch) — not a crash. Settle to a
        // quiet "exited" state without a failure banner or auto-recovery.
        if (stopping) {
          stopping = false;
          set({ status: "exited", exitCode: code });
          return;
        }

        if (code === 0) {
          set({ status: "exited", exitCode: code });
          return;
        }

        // Non-zero exit. If we already saw a port conflict stream past, heal
        // immediately (no banner flash). Otherwise mark it failed but give
        // trailing output a brief window to land in case the conflict line
        // raced the exit, then re-evaluate.
        if (
          portConflictSeen &&
          !recoveryAttempted &&
          get().projectPath &&
          (get().busyPort ?? extractBusyPort(joinLog(get().log))) != null
        ) {
          void beginRecovery();
          return;
        }

        set({ status: "failed", exitCode: code });
        const seq = runSeq;
        setTimeout(() => {
          if (runSeq !== seq) return; // superseded by a newer run
          if (recoveryAttempted) return;
          if (get().status !== "failed") return; // user already acted
          const st = get();
          const port = st.busyPort ?? extractBusyPort(joinLog(st.log));
          const conflict = portConflictSeen || isPortInUseError(joinLog(st.log));
          if (conflict && port != null && st.projectPath) void beginRecovery();
        }, FAILURE_SETTLE_MS);
      });

      unlistenFns = [u1, u2];

      /** Kick off automatic port-free + restart for the current failure. */
      async function beginRecovery() {
        const st = get();
        const port = st.busyPort ?? extractBusyPort(joinLog(st.log));
        if (port == null || !st.projectPath || recoveryAttempted) {
          set({ status: "failed" });
          return;
        }
        recoveryAttempted = true;
        set({ status: "recovering" });
        useRuntimeStore.getState().pushToast({
          kind: "info",
          text: `Port ${port} was held by a leftover process — freeing it and restarting the dev server.`,
        });
        await freeAndStart(port, st.projectPath, true);
      }
    },

    detachListeners: () => {
      unlistenFns.forEach((fn) => fn());
      unlistenFns = [];
      set({ listenersAttached: false });
    },

    clearLog: () =>
      set({ log: [], detectedUrl: null, busyPort: null, exitCode: null, error: null }),

    start: async (projectPath) => {
      await startInternal(projectPath, false);
    },

    stop: async () => {
      if (get().status !== "running" && get().status !== "recovering") return;
      stopping = true;
      try {
        await stopDevServer();
      } catch (err) {
        stopping = false;
        set({ error: asAppError(err) });
      }
    },

    freePortAndRestart: async (port) => {
      const projectPath = get().projectPath;
      if (!projectPath) return;
      // A manual free+restart is a fresh attempt — re-arm auto-recovery so the
      // user isn't left without it if they hit the same wall again.
      recoveryAttempted = false;
      set({ status: "recovering" });
      await freeAndStart(port, projectPath, false);
    },

    reset: async () => {
      // Kill the running server so the new project can claim the port and so
      // we're not leaving an orphan process the UI can no longer reach.
      if (get().status === "running" || get().status === "recovering") {
        stopping = true;
        try {
          await stopDevServer();
        } catch {
          // Ignore — we're tearing down regardless.
        }
      }
      recoveryAttempted = false;
      portConflictSeen = false;
      stopping = false;
      set({
        status: "idle",
        log: [],
        detectedUrl: null,
        busyPort: null,
        exitCode: null,
        error: null,
        projectPath: null,
      });
    },
  };
});

/** Join a log buffer into a single string for whole-buffer error matching. */
function joinLog(log: LogLine[]): string {
  return log.map((l) => l.line).join("\n");
}
