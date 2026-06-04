import { useEffect, useMemo, useState } from "react";
import { Play, Stop, ArrowCounterClockwise } from "@phosphor-icons/react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useAgentsStore } from "../../stores/use-agents-store";
import { useProjectConfigStore } from "../../stores/use-project-config-store";
import { useAgentRunnerStore } from "./use-agent-runner-store";
import { StatusPill } from "./StatusPill";
import { LogView } from "./LogView";
import { AgentSelector } from "./AgentSelector";

type Props = {
  projectPath?: string | null;
};

export function AgentRunner({ projectPath }: Props) {
  const [task, setTask] = useState("");

  const agents = useAgentsStore((s) => s.agents);
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId);
  const selected = useMemo(
    () => agents.find((a) => a.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );

  // Verify cmd is sourced from the active project's config (single source of
  // truth). The Settings panel (TaskWorkspace) is where the user edits it.
  const verifyCmd = useProjectConfigStore((s) => s.config?.agent.verify_cmd ?? "");
  const setVerifyCmd = useProjectConfigStore((s) => s.setVerifyCmd);
  const [verifyDraft, setVerifyDraft] = useState(verifyCmd);
  useEffect(() => {
    setVerifyDraft(verifyCmd);
  }, [verifyCmd, projectPath]);

  const status = useAgentRunnerStore((s) => s.status);
  const agentLog = useAgentRunnerStore((s) => s.agentLog);
  const exitCode = useAgentRunnerStore((s) => s.exitCode);
  const error = useAgentRunnerStore((s) => s.error);
  const start = useAgentRunnerStore((s) => s.start);
  const stop = useAgentRunnerStore((s) => s.stop);
  const reset = useAgentRunnerStore((s) => s.reset);
  const attachListeners = useAgentRunnerStore((s) => s.attachListeners);

  useEffect(() => {
    void attachListeners();
  }, [attachListeners]);

  const onRun = async () => {
    if (!selected.bin || !projectPath) return;
    // The backend reads `.äkä/config.json` on every `runAgent` call, so the
    // currently-selected agent (mirrored into the project config by
    // `selectAgent`) is what actually launches.
    await start(task, projectPath);
  };

  const isBusy = status === "running";
  const canRun = !!selected.bin && !!projectPath && selected.installed;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 text-white">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white/80">Agent</span>
          <StatusPill status={status} />
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
                  : !selected.installed
                    ? selected.install
                      ? `Install with: ${selected.install}`
                      : "Agent not installed"
                    : "Run agent"
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/20 px-3 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
            >
              <Play size={12} weight="fill" />
              Run
            </button>
          )}
        </div>
      </div>

      <AgentSelector />

      <div className="flex flex-col gap-1">
        <label className="text-xs uppercase tracking-wide text-white/40">
          Task
        </label>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          placeholder={`Describe what ${selected.name} should do…`}
          className="resize-y rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs uppercase tracking-wide text-white/40">
          Verify command{" "}
          <span className="text-white/30 normal-case">
            (.äkä/config.json — runs after every agent run)
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

      <div className="min-h-0 flex-1">
        <div className="mb-1 flex items-center justify-between text-xs text-white/50">
          <span>Output</span>
          {exitCode !== null && (
            <span className="font-mono">exit {exitCode}</span>
          )}
        </div>
        <div className="h-64">
          <LogView lines={agentLog} empty="Run an agent to see output." />
        </div>
      </div>

      {error && <ErrorBanner error={error} />}
    </div>
  );
}
