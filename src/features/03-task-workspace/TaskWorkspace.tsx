import { useEffect, useMemo, useState } from "react";
import { Play, Stop, ArrowCounterClockwise, Warning } from "@phosphor-icons/react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useAgentsStore } from "../../stores/use-agents-store";
import { useProjectConfigStore } from "../../stores/use-project-config-store";
import { useSessionStore } from "../../stores/use-session-store";
import { LogView } from "../02-agent-runner/LogView";
import { HandoffPanel } from "./HandoffPanel";
import { TaskStatusPill } from "./TaskStatusPill";
import { VerifySection } from "./VerifySection";
import { useTaskWorkspaceStore } from "./use-task-workspace-store";
import type { AppError } from "../../lib/tauri/commands";

type Props = {
  projectPath?: string | null;
};

/**
 * Task-first workspace: launches the project's configured agent, runs the
 * project's verify command after `agent://done`, and feeds failures back to
 * the LLM for self-correction up to `max_retries`. Every config value comes
 * from `.äkä/config.json`; pass/fail derives purely from the verify exit
 * code.
 */
export function TaskWorkspace({ projectPath }: Props) {
  const [task, setTask] = useState("");

  const agents = useAgentsStore((s) => s.agents);
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId);
  const selected = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );

  // Project config — the source of truth for verify cmd + max retries.
  const config = useProjectConfigStore((s) => s.config);
  const setVerifyCmd = useProjectConfigStore((s) => s.setVerifyCmd);
  const setMaxRetries = useProjectConfigStore((s) => s.setMaxRetries);

  const [verifyDraft, setVerifyDraft] = useState("");
  const [maxRetriesInput, setMaxRetriesInput] = useState("3");
  useEffect(() => {
    setVerifyDraft(config?.agent.verify_cmd ?? "");
    setMaxRetriesInput(String(config?.max_retries ?? 3));
  }, [config?.agent.verify_cmd, config?.max_retries, projectPath]);

  const status = useTaskWorkspaceStore((s) => s.status);
  const agentLog = useTaskWorkspaceStore((s) => s.agentLog);
  const attempt = useTaskWorkspaceStore((s) => s.attempt);
  const maxRetries = useTaskWorkspaceStore((s) => s.maxRetries);
  const agentExitCode = useTaskWorkspaceStore((s) => s.agentExitCode);
  const notice = useTaskWorkspaceStore((s) => s.notice);
  const error = useTaskWorkspaceStore((s) => s.error);
  const lastFailedAction = useTaskWorkspaceStore((s) => s.lastFailedAction);
  const start = useTaskWorkspaceStore((s) => s.start);
  const stop = useTaskWorkspaceStore((s) => s.stop);
  const reset = useTaskWorkspaceStore((s) => s.reset);
  const retry = useTaskWorkspaceStore((s) => s.retry);
  const attachListeners = useTaskWorkspaceStore((s) => s.attachListeners);

  // Project-config errors live in their own store — load_config failures
  // during a project switch land here, and the Reset action wipes the file
  // back to defaults so the user is unblocked without manual editing.
  const configError = useProjectConfigStore((s) => s.error);
  const resetConfigToDefaults = useProjectConfigStore(
    (s) => s.resetToDefaults,
  );

  useEffect(() => {
    void attachListeners();
  }, [attachListeners]);

  // NoAgentsInstalled is a frontend-derived banner: if every detected agent
  // came back installed: false, we synthesize the variant on the fly with
  // the install hints from the detector. Doesn't require a Tauri call.
  const noAgentsError = useMemo<AppError | null>(() => {
    const real = agents.filter((a) => a.bin); // skip the Custom-script row
    if (real.length === 0) return null;
    if (real.some((a) => a.installed)) return null;
    return {
      kind: "NoAgentsInstalled",
      hints: real
        .map((a) => a.install)
        .filter((s): s is string => !!s && s.length > 0),
    };
  }, [agents]);

  // ConfigCorrupted is the only blocking variant the project-config store
  // produces — the workspace promotes it to the same banner pipeline as
  // run_agent / run_verify failures.
  const blockingConfigError: AppError | null = configError;

  // The most recently-failed handoff summary, if any. Rendered as a soft
  // amber banner — the session moved on, but the user should know.
  const handoffs = useSessionStore((s) => s.handoffs);
  const summarizationError = useMemo<AppError | null>(() => {
    const lastFailed = [...handoffs].reverse().find((h) => h.status === "failed");
    return lastFailed ? { kind: "SummarizationFailed" } : null;
  }, [handoffs]);

  // Broken-bin warning: the project's configured agent.bin doesn't match any
  // installed agent detected by `detect_agents`. The user opened a project
  // whose config was authored against an agent that isn't on this machine.
  const configuredBin = config?.agent.bin ?? "";
  const brokenBinWarning = useMemo(() => {
    if (!configuredBin) return null;
    const match = agents.find((a) => a.bin === configuredBin);
    if (!match) {
      return `This project's config uses agent "${configuredBin}", which isn't a built-in or detected agent.`;
    }
    if (!match.installed) {
      return `This project's configured agent (${match.name}) is not installed${match.install ? `. Install with: ${match.install}` : "."}`;
    }
    return null;
  }, [configuredBin, agents]);

  const onRun = async () => {
    if (!selected?.bin || !projectPath) return;
    await start(task, projectPath);
  };

  const isBusy = status === "running" || status === "verifying";
  // Only RuntimeOffline and ConfigCorrupted are blocking — every other
  // AppError lets the user keep working (and optionally retry).
  const isBlockingError =
    blockingConfigError !== null ||
    error?.kind === "RuntimeOffline" ||
    error?.kind === "ConfigCorrupted";
  const canRun =
    !!selected?.bin &&
    !!projectPath &&
    !!selected?.installed &&
    !brokenBinWarning &&
    !isBlockingError &&
    !noAgentsError;
  const showAttempt = isBusy && maxRetries > 1;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 text-white">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/80">Task</span>
          <TaskStatusPill status={status} />
          {showAttempt && (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-white/70">
              Attempt {attempt} of {maxRetries}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-40"
          >
            <ArrowCounterClockwise size={12} weight="bold" />
            Reset
          </button>
          {isBusy ? (
            <button
              type="button"
              onClick={stop}
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/40 bg-rose-500/20 px-3 py-1 text-xs font-medium text-rose-100 hover:bg-rose-500/30"
            >
              <Stop size={12} weight="fill" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              title={
                !projectPath
                  ? "Open a project first"
                  : brokenBinWarning
                    ? brokenBinWarning
                    : !selected?.installed
                      ? "Agent not installed"
                      : "Run task"
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
            >
              <Play size={12} weight="fill" />
              Run
            </button>
          )}
        </div>
      </div>

      {brokenBinWarning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
          <div>{brokenBinWarning}</div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs uppercase tracking-wide text-white/40">
          Task
        </label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          placeholder={`Describe what ${selected?.name ?? "the agent"} should build…`}
          className="resize-y rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
        />
      </div>

      {/* Per-project Settings (verify_cmd + max_retries). Each input writes
          straight to .äkä/config.json on blur — no save button. */}
      <div className="grid grid-cols-[1fr_120px] gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-white/40">
            Verify command{" "}
            <span className="normal-case text-white/30">
              (.äkä/config.json · runs after every agent run)
            </span>
          </label>
          <input
            value={verifyDraft}
            onChange={(e) => setVerifyDraft(e.target.value)}
            onBlur={(e) => void setVerifyCmd(e.target.value)}
            placeholder="e.g. tsc --noEmit"
            disabled={!projectPath}
            className="rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none disabled:opacity-40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs uppercase tracking-wide text-white/40">
            Max retries
          </label>
          <input
            type="number"
            min={1}
            max={20}
            value={maxRetriesInput}
            onChange={(e) => setMaxRetriesInput(e.target.value)}
            onBlur={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              const clamped = Number.isFinite(n) && n > 0 ? n : 3;
              setMaxRetriesInput(String(clamped));
              void setMaxRetries(clamped);
            }}
            disabled={!projectPath}
            className="rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none disabled:opacity-40"
          />
        </div>
      </div>

      <HandoffPanel />

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-1 flex items-center justify-between text-xs text-white/50">
            <span>Agent output</span>
            {agentExitCode !== null && (
              <span className="font-mono">exit {agentExitCode}</span>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <LogView lines={agentLog} empty="Run a task to see agent output." />
          </div>
        </div>
        <VerifySection />
      </div>

      {blockingConfigError && (
        <ErrorBanner
          error={blockingConfigError}
          onResetConfig={() => void resetConfigToDefaults()}
        />
      )}
      {noAgentsError && <ErrorBanner error={noAgentsError} />}
      {error && (
        <ErrorBanner
          error={error}
          onRetry={lastFailedAction ? () => void retry() : undefined}
          onResetConfig={
            error.kind === "ConfigCorrupted"
              ? () => void resetConfigToDefaults()
              : undefined
          }
        />
      )}
      {summarizationError && <ErrorBanner error={summarizationError} />}
      {selected && selected.bin && !selected.installed && !brokenBinWarning && !noAgentsError && (
        <div className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {selected.name} is not installed. Select another agent or install it
          to continue.
          {selected.install ? (
            <div className="mt-1 font-mono text-[11px] text-amber-200/80">
              {selected.install}
            </div>
          ) : null}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {notice}
        </div>
      )}
    </div>
  );
}
