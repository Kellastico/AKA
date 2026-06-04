import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  asAppError,
  callLlm,
  loadConfig,
  runAgent,
  runVerify,
  stopAgent,
  type AppError,
} from "../../lib/tauri/commands";
import { useSessionStore } from "../../stores/use-session-store";
import { useRuntimeStore } from "../01-llm-provider/use-runtime-store";

/**
 * Snapshot the live runtime selection so it can be forwarded to `runAgent` as
 * overrides — sidesteps the disk write-before-read race where a just-switched
 * model hasn't been flushed to `.äkä/config.json` yet.
 */
function liveRuntimeOverrides(): [string | undefined, string | undefined, string | null] {
  const { selectedModelId, active } = useRuntimeStore.getState();
  return [selectedModelId ?? undefined, active?.baseUrl ?? undefined, active?.apiKey ?? null];
}

export type LogStream = "stdout" | "stderr";
export type LogLine = { id: number; line: string; stream: LogStream };
export type TaskStatus =
  | "idle"
  | "running"
  | "verifying"
  | "passed"
  | "failed";

type LinePayload = { line: string; stream: LogStream };
type DonePayload = { exitCode: number };

const DEFAULT_MAX_RETRIES = 3;
const VERIFY_TAIL_LINES = 50;

let lineCounter = 0;
const nextId = () => ++lineCounter;

type TaskWorkspaceState = {
  status: TaskStatus;
  agentLog: LogLine[];
  verifyLog: LogLine[];
  verifyExpanded: boolean;
  agentExitCode: number | null;
  verifyExitCode: number | null;
  attempt: number;
  maxRetries: number;
  notice: string | null;
  /**
   * Last command failure, mapped through `asAppError`. Drives <ErrorBanner>.
   * `null` while everything is fine.
   */
  error: AppError | null;
  /**
   * The most recent input that produced `error`, captured so a Retry button
   * can re-run the exact same command. Cleared whenever `error` is cleared.
   */
  lastFailedAction: "runAgent" | "runVerify" | "callLlm" | null;

  // Cached for the self-correction loop.
  activeProjectPath: string | null;
  originalTask: string | null;

  listenersAttached: boolean;
  attachListeners: () => Promise<void>;
  detachListeners: () => void;

  reset: () => void;
  clearError: () => void;
  setVerifyExpanded: (v: boolean) => void;

  start: (task: string, projectPath: string) => Promise<void>;
  retry: () => Promise<void>;
  stop: () => Promise<void>;
};

let unlistenFns: UnlistenFn[] = [];

/**
 * Builds the next-attempt prompt fed to the LLM when verification fails.
 * Captures the verify output tail + the original task so the model has full
 * context for self-correction. Pure helper — exported only for testability.
 */
export function buildCorrectionPrompt(
  verifyTail: string,
  originalTask: string,
): string {
  return (
    `Verification failed with the following output:\n${verifyTail}\n\n` +
    `Fix the issues and try again.\n\n` +
    `Original task:\n${originalTask}`
  );
}

/**
 * One-line audit summary appended to the agent log every time a command
 * fails — the user gets a timestamped record of what went wrong without
 * having to read the banner history. Exported for tests.
 */
export function formatErrorForLog(error: AppError): string {
  const ts = new Date().toISOString();
  switch (error.kind) {
    case "RuntimeOffline":
      return `[${ts}] ERROR: LLM runtime offline`;
    case "NoAgentsInstalled":
      return `[${ts}] ERROR: no coding agents installed`;
    case "AgentCrash":
      return `[${ts}] ERROR: agent crashed (exit ${error.exitCode})`;
    case "VerifyCommandNotFound":
      return `[${ts}] ERROR: verify command not found: ${error.cmd}`;
    case "SandboxViolation":
      return `[${ts}] SECURITY: blocked path outside sandbox: ${error.path}`;
    case "ConfigCorrupted":
      return `[${ts}] ERROR: config corrupted: ${error.reason}`;
    case "SummarizationFailed":
      return `[${ts}] WARN: session summary failed — starting fresh`;
    case "BackendUnavailable":
      return `[${ts}] ERROR: backend command unavailable: ${error.reason}`;
  }
}

export const useTaskWorkspaceStore = create<TaskWorkspaceState>((set, get) => ({
  status: "idle",
  agentLog: [],
  verifyLog: [],
  verifyExpanded: false,
  agentExitCode: null,
  verifyExitCode: null,
  attempt: 1,
  maxRetries: DEFAULT_MAX_RETRIES,
  notice: null,
  error: null,
  lastFailedAction: null,
  activeProjectPath: null,
  originalTask: null,
  listenersAttached: false,

  attachListeners: async () => {
    if (get().listenersAttached) return;
    set({ listenersAttached: true });

    const u1 = await listen<LinePayload>("agent://output", (e) => {
      // Only collect agent output while we're actively running an agent.
      if (get().status !== "running") return;
      set((s) => ({
        agentLog: [
          ...s.agentLog,
          { id: nextId(), line: e.payload.line, stream: e.payload.stream },
        ],
      }));
    });

    const u2 = await listen<LinePayload>("verify://output", (e) => {
      if (get().status !== "verifying") return;
      set((s) => ({
        verifyLog: [
          ...s.verifyLog,
          { id: nextId(), line: e.payload.line, stream: e.payload.stream },
        ],
      }));
    });

    const u3 = await listen<DonePayload>("agent://done", async (e) => {
      const { activeProjectPath, status, originalTask } = get();
      if (status !== "running" || !activeProjectPath) return;

      set({ agentExitCode: e.payload.exitCode });

      // If the agent crashed, run_agent itself returns AppError::AgentCrash
      // and is handled in start()'s catch. Skip verification — the agent
      // didn't do any work to verify.
      if (e.payload.exitCode !== 0) return;

      // Read project config fresh — the user may have edited verify_cmd
      // or max_retries during the agent run. The Rust side also re-reads
      // it on its own; this lookup is just for the TS orchestration.
      let verifyCmd = "";
      try {
        const cfg = await loadConfig(activeProjectPath);
        verifyCmd = cfg?.agent.verify_cmd?.trim() ?? "";
        if (cfg?.max_retries && cfg.max_retries > 0) {
          set({ maxRetries: cfg.max_retries });
        }
      } catch (err) {
        const appErr = asAppError(err);
        set((s) => ({
          status: "failed",
          error: appErr,
          lastFailedAction: null,
          agentLog: [
            ...s.agentLog,
            { id: nextId(), line: formatErrorForLog(appErr), stream: "stderr" },
          ],
        }));
        return;
      }

      if (!verifyCmd) {
        // No verification configured — task is done.
        useSessionStore
          .getState()
          .appendAgentEvent(originalTask ?? "", [], "n/a");
        set({ status: "passed" });
        return;
      }

      set({ status: "verifying", verifyLog: [], verifyExitCode: null });

      try {
        const exit = await runVerify(activeProjectPath);
        await onVerifyDone(set, get, exit);
      } catch (err) {
        const appErr = asAppError(err);
        set((s) => ({
          status: "failed",
          verifyExpanded: true,
          error: appErr,
          lastFailedAction:
            appErr.kind === "SandboxViolation" ? null : "runVerify",
          agentLog: [
            ...s.agentLog,
            { id: nextId(), line: formatErrorForLog(appErr), stream: "stderr" },
          ],
        }));
      }
    });

    unlistenFns = [u1, u2, u3];
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
      verifyLog: [],
      verifyExpanded: false,
      agentExitCode: null,
      verifyExitCode: null,
      attempt: 1,
      notice: null,
      error: null,
      lastFailedAction: null,
      // Keep activeProjectPath + originalTask so a Retry after Reset still
      // has the inputs it needs. Reset clears banners, not the task input.
    }),

  clearError: () => set({ error: null, lastFailedAction: null }),

  setVerifyExpanded: (v) => set({ verifyExpanded: v }),

  start: async (task, projectPath) => {
    await get().attachListeners();

    // loadConfig now throws AppError::ConfigCorrupted on parse failure.
    // We surface it via the banner instead of silently falling back, so the
    // user knows the on-disk file needs attention.
    let maxRetries = DEFAULT_MAX_RETRIES;
    try {
      const cfg = await loadConfig(projectPath);
      if (cfg?.max_retries && cfg.max_retries > 0) {
        maxRetries = cfg.max_retries;
      }
    } catch (err) {
      const appErr = asAppError(err);
      set((s) => ({
        status: "failed",
        error: appErr,
        lastFailedAction: null,
        activeProjectPath: projectPath,
        originalTask: task,
        agentLog: [
          ...s.agentLog,
          { id: nextId(), line: formatErrorForLog(appErr), stream: "stderr" },
        ],
      }));
      return;
    }

    // Track the user turn for any future handoff, and pull the staged summary
    // (if a swap happened since the last run) into the system context.
    const session = useSessionStore.getState();
    session.appendMessage("user", task);
    const prefix = session.consumeSummaryPrefix();
    const finalTask = prefix ? `${prefix}\n\n${task}` : task;

    set({
      status: "running",
      agentLog: [],
      verifyLog: [],
      verifyExpanded: false,
      agentExitCode: null,
      verifyExitCode: null,
      attempt: 1,
      maxRetries,
      notice: null,
      error: null,
      lastFailedAction: null,
      activeProjectPath: projectPath,
      originalTask: task,
    });

    try {
      const [model, baseUrl, apiKey] = liveRuntimeOverrides();
      await runAgent(finalTask, projectPath, undefined, model, baseUrl, apiKey);
    } catch (err) {
      const appErr = asAppError(err);
      set((s) => ({
        status: "failed",
        error: appErr,
        // Sandbox violations are not retryable — the path itself is the
        // problem. Everything else (agent crash, etc.) re-runs runAgent.
        lastFailedAction: appErr.kind === "SandboxViolation" ? null : "runAgent",
        agentLog: [
          ...s.agentLog,
          { id: nextId(), line: formatErrorForLog(appErr), stream: "stderr" },
        ],
      }));
    }
  },

  retry: async () => {
    const { lastFailedAction, originalTask, activeProjectPath } = get();
    if (!lastFailedAction || !activeProjectPath) return;
    if (lastFailedAction === "runAgent") {
      if (originalTask == null) return;
      await get().start(originalTask, activeProjectPath);
    } else if (lastFailedAction === "runVerify") {
      // Re-enter the verify branch with the same exit-code handling the
      // agent://done listener used originally.
      set({ status: "verifying", verifyLog: [], verifyExitCode: null, error: null });
      try {
        const exit = await runVerify(activeProjectPath);
        await onVerifyDone(set, get, exit);
      } catch (err) {
        const appErr = asAppError(err);
        set((s) => ({
          status: "failed",
          error: appErr,
          lastFailedAction:
            appErr.kind === "SandboxViolation" ? null : "runVerify",
          agentLog: [
            ...s.agentLog,
            { id: nextId(), line: formatErrorForLog(appErr), stream: "stderr" },
          ],
        }));
      }
    }
  },

  stop: async () => {
    const { status } = get();
    if (status !== "running" && status !== "verifying") return;
    try {
      await stopAgent();
    } catch {
      // stopAgent failures aren't actionable — the kill signal either lands
      // or the process is already gone. Don't surface as an AppError.
    }
    set({ status: "failed", notice: "Stopped by user" });
  },
}));

/**
 * Handles a completed verify run. Exit 0 → passed. Non-zero → failed:
 * either kick off self-correction (call_llm → run_agent) or stop if we've
 * hit `maxRetries`. Lives outside the store so the `agent://done` listener
 * can call it without re-entering Zustand setters.
 */
async function onVerifyDone(
  set: (
    partial:
      | Partial<TaskWorkspaceState>
      | ((s: TaskWorkspaceState) => Partial<TaskWorkspaceState>),
  ) => void,
  get: () => TaskWorkspaceState,
  exitCode: number,
): Promise<void> {
  set({ verifyExitCode: exitCode });

  if (exitCode === 0) {
    useSessionStore
      .getState()
      .appendAgentEvent(get().originalTask ?? "", [], "passed");
    set({ status: "passed" });
    return;
  }

  // Failure: auto-expand verify log so the user immediately sees why.
  set({ verifyExpanded: true });

  const {
    attempt,
    maxRetries,
    verifyLog,
    activeProjectPath,
    originalTask,
  } = get();

  if (attempt >= maxRetries) {
    useSessionStore
      .getState()
      .appendAgentEvent(originalTask ?? "", [], "failed");
    set({
      status: "failed",
      notice: "Max retries reached — review the verification output and retry manually.",
    });
    return;
  }
  if (!activeProjectPath || originalTask == null) {
    set({ status: "failed" });
    return;
  }

  const tail = verifyLog
    .slice(-VERIFY_TAIL_LINES)
    .map((l) => l.line)
    .join("\n");
  const prompt = buildCorrectionPrompt(tail, originalTask);

  set({ status: "running", agentLog: [], attempt: attempt + 1 });

  let llmReply: string;
  try {
    const handoffPrefix = useSessionStore.getState().consumeSummaryPrefix();
    const systemContent = handoffPrefix
      ? `${handoffPrefix}\n\nYou are fixing code so that the project's verification command passes. Respond with the corrected task description / instructions for the coding agent.`
      : "You are fixing code so that the project's verification command passes. Respond with the corrected task description / instructions for the coding agent.";
    llmReply = await callLlm(
      [
        { role: "system", content: systemContent },
        { role: "user", content: prompt },
      ],
      activeProjectPath,
      null,
    );
    useSessionStore.getState().appendMessage("assistant", llmReply);
  } catch (err) {
    const appErr = asAppError(err);
    set((s) => ({
      status: "failed",
      error: appErr,
      // The LLM call is part of the verify loop — retry should re-enter from
      // runVerify so the next attempt picks up the same verify output tail.
      lastFailedAction:
        appErr.kind === "SandboxViolation" ? null : "runVerify",
      agentLog: [
        ...s.agentLog,
        { id: nextId(), line: formatErrorForLog(appErr), stream: "stderr" },
      ],
    }));
    return;
  }

  try {
    const [model, baseUrl, apiKey] = liveRuntimeOverrides();
    await runAgent(llmReply, activeProjectPath, undefined, model, baseUrl, apiKey);
  } catch (err) {
    const appErr = asAppError(err);
    set((s) => ({
      status: "failed",
      error: appErr,
      lastFailedAction:
        appErr.kind === "SandboxViolation" ? null : "runAgent",
      agentLog: [
        ...s.agentLog,
        { id: nextId(), line: formatErrorForLog(appErr), stream: "stderr" },
      ],
    }));
  }
}
