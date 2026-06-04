import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { asAppError, runAgent, stopAgent, type AppError } from "../../lib/tauri/commands";
import { useRuntimeStore } from "../01-llm-provider/use-runtime-store";

export type LogStream = "stdout" | "stderr";
export type LogLine = { id: number; line: string; stream: LogStream };

export type RunStatus = "idle" | "running" | "passed" | "failed" | "cancelled";

type LinePayload = { line: string; stream: LogStream };
type DonePayload = { exitCode: number };

let lineCounter = 0;
const nextId = () => ++lineCounter;

type AgentRunnerState = {
  status: RunStatus;
  agentLog: LogLine[];
  exitCode: number | null;
  error: AppError | null;
  cancelling: boolean;
  listenersAttached: boolean;
  attachListeners: () => Promise<void>;
  detachListeners: () => void;
  reset: () => void;
  start: (task: string, projectPath: string) => Promise<void>;
  stop: () => Promise<void>;
};

let unlistenFns: UnlistenFn[] = [];

export const useAgentRunnerStore = create<AgentRunnerState>((set, get) => ({
  status: "idle",
  agentLog: [],
  exitCode: null,
  error: null,
  cancelling: false,
  listenersAttached: false,

  attachListeners: async () => {
    if (get().listenersAttached) return;
    set({ listenersAttached: true });

    const u1 = await listen<LinePayload>("agent://output", (e) => {
      set((s) => ({
        agentLog: [
          ...s.agentLog,
          { id: nextId(), line: e.payload.line, stream: e.payload.stream },
        ],
      }));
    });

    const u2 = await listen<DonePayload>("agent://done", (e) => {
      const { exitCode } = e.payload;
      const cancelling = get().cancelling;
      set({
        status: cancelling
          ? "cancelled"
          : exitCode === 0
            ? "passed"
            : "failed",
        exitCode,
        cancelling: false,
      });
    });

    unlistenFns = [u1, u2];
  },

  detachListeners: () => {
    unlistenFns.forEach((fn) => fn());
    unlistenFns = [];
    set({ listenersAttached: false });
  },

  reset: () =>
    set({
      status: "idle",
      agentLog: [],
      exitCode: null,
      error: null,
      cancelling: false,
    }),

  start: async (task, projectPath) => {
    await get().attachListeners();
    set({
      status: "running",
      agentLog: [],
      exitCode: null,
      error: null,
      cancelling: false,
    });

    // Resolves the first time `status` transitions away from "running" — the
    // `agent://done` listener does that. Without this wait, callers can race
    // past `start()` while status is still "running" because the done event
    // hasn't been processed yet.
    const settled = new Promise<void>((resolve) => {
      const unsub = useAgentRunnerStore.subscribe((s) => {
        if (s.status !== "running") {
          unsub();
          resolve();
        }
      });
    });

    try {
      // Forward the live model/runtime as overrides so a just-switched model is
      // honoured even if its config write is still in flight.
      const { selectedModelId, active } = useRuntimeStore.getState();
      await runAgent(
        task,
        projectPath,
        undefined,
        selectedModelId ?? undefined,
        active?.baseUrl ?? undefined,
        active?.apiKey ?? null,
      );
    } catch (err) {
      set({ status: "failed", error: asAppError(err) });
      return;
    }
    await settled;
  },

  stop: async () => {
    if (get().status !== "running") return;
    set({ cancelling: true });
    try {
      await stopAgent();
    } catch (err) {
      set({
        cancelling: false,
        error: asAppError(err),
      });
    }
  },
}));
