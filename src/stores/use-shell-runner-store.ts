import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  runShellCommand,
  stopShellCommand,
} from "../lib/tauri/commands";

export type LogStream = "stdout" | "stderr";
export type LogLine = { id: number; line: string; stream: LogStream };
export type ShellStatus = "idle" | "running" | "done" | "failed";

type LinePayload = { line: string; stream: LogStream };
type DonePayload = { exitCode: number };

const LOG_LIMIT = 2_000;

let lineCounter = 0;
const nextId = () => ++lineCounter;

type ShellRunnerState = {
  status: ShellStatus;
  /** All emitted lines including the `$ cmd` header and `[exited N]` footer. */
  log: LogLine[];
  /** Stack of previously-run commands, newest first. Up/Down recalls in the input. */
  history: string[];
  exitCode: number | null;
  currentCmd: string | null;
  listenersAttached: boolean;
  attachListeners: () => Promise<void>;
  detachListeners: () => void;
  clearLog: () => void;
  run: (projectPath: string, cmd: string) => Promise<void>;
  stop: () => Promise<void>;
};

let unlistenFns: UnlistenFn[] = [];

function pushLine(
  log: LogLine[],
  line: string,
  stream: LogStream,
): LogLine[] {
  const next = [...log, { id: nextId(), line, stream }];
  if (next.length > LOG_LIMIT) next.splice(0, next.length - LOG_LIMIT);
  return next;
}

/**
 * Drives the interactive shell in the Console pane. Mirrors the dev-server
 * store shape (status / log / start / stop) but for one-shot user commands.
 * The Console UI calls `run()` with a free-form shell line; output streams
 * back via `shell://*` events that this store listens for.
 */
export const useShellRunnerStore = create<ShellRunnerState>((set, get) => ({
  status: "idle",
  log: [],
  history: [],
  exitCode: null,
  currentCmd: null,
  listenersAttached: false,

  attachListeners: async () => {
    if (get().listenersAttached) return;
    set({ listenersAttached: true });

    const u1 = await listen<LinePayload>("shell://output", (e) => {
      set((s) => ({
        log: pushLine(s.log, e.payload.line, e.payload.stream),
      }));
    });

    const u2 = await listen<DonePayload>("shell://done", (e) => {
      set((s) => ({
        status: e.payload.exitCode === 0 ? "done" : "failed",
        exitCode: e.payload.exitCode,
        currentCmd: null,
        log: pushLine(
          s.log,
          `[exited ${e.payload.exitCode}]`,
          e.payload.exitCode === 0 ? "stdout" : "stderr",
        ),
      }));
    });

    unlistenFns = [u1, u2];
  },

  detachListeners: () => {
    unlistenFns.forEach((fn) => fn());
    unlistenFns = [];
    set({ listenersAttached: false });
  },

  clearLog: () =>
    set({
      log: [],
      exitCode: null,
      status: get().status === "running" ? "running" : "idle",
    }),

  run: async (projectPath, cmd) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    await get().attachListeners();

    // Echo the command as a header line so the log reads like a real terminal
    // session. Stored under stdout so it renders in white, not red.
    set((s) => ({
      status: "running",
      currentCmd: trimmed,
      exitCode: null,
      log: pushLine(s.log, `$ ${trimmed}`, "stdout"),
      history: [trimmed, ...s.history.filter((h) => h !== trimmed)].slice(0, 50),
    }));

    try {
      await runShellCommand(projectPath, trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        status: "failed",
        currentCmd: null,
        log: pushLine(s.log, `[failed to spawn: ${msg}]`, "stderr"),
      }));
    }
  },

  stop: async () => {
    if (get().status !== "running") return;
    try {
      await stopShellCommand();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => ({
        log: pushLine(s.log, `[stop failed: ${msg}]`, "stderr"),
      }));
    }
  },
}));
