import { useEffect, useMemo, useRef, useState } from "react";
import { Broom, Folder, Play, Stop } from "@phosphor-icons/react";
import { useDevServerStore } from "../../stores/use-dev-server-store";
import { useShellRunnerStore } from "../../stores/use-shell-runner-store";
import { useAgentRunnerStore } from "../../features/02-agent-runner/use-agent-runner-store";
import { useTaskWorkspaceStore } from "../../features/03-task-workspace/use-task-workspace-store";
import { useProjectsStore } from "../../stores/use-projects-store";
import { Tooltip } from "../Tooltip";

/**
 * Compact display path for prompts/headers. Replaces a `/Users/<name>/` prefix
 * with `~/` so the prompt reads like a real shell on macOS/Linux without
 * exposing the user's home directory in screenshots. Falls through unchanged
 * on Windows or unusual layouts.
 */
function tildify(absPath: string): string {
  const m = absPath.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ""}`;
  return absPath;
}

type SourceTag = "dev" | "agent" | "verify" | "shell";

type TaggedLine = {
  source: SourceTag;
  id: number;
  line: string;
  stream: "stdout" | "stderr";
};

const SOURCE_COLOR: Record<SourceTag, string> = {
  dev: "text-cyan-400/80",
  agent: "text-emerald-400/80",
  verify: "text-amber-400/80",
  shell: "text-fuchsia-400/80",
};

/**
 * Interactive project console.
 *
 * Reads (passive): dev-server, agent-runner, verify-runner streams.
 * Writes (interactive): a free-form shell input at the bottom that runs
 * the line via `sh -c` in the project sandbox (Rust `shell_run`).
 *
 * One shell command at a time — re-submitting kills the previous one (the
 * Rust side enforces this too). Up/Down arrows in the input recall history.
 */
export function ConsoleContent() {
  const activeProject = useProjectsStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  const projectPath = activeProject?.path ?? null;
  const projectName = activeProject?.name ?? null;
  const tildePath = projectPath ? tildify(projectPath) : null;

  const devLog = useDevServerStore((s) => s.log);
  const devClear = useDevServerStore((s) => s.clearLog);
  const devAttach = useDevServerStore((s) => s.attachListeners);

  const agentLog = useAgentRunnerStore((s) => s.agentLog);
  const agentAttach = useAgentRunnerStore((s) => s.attachListeners);
  const agentReset = useAgentRunnerStore((s) => s.reset);

  const verifyLog = useTaskWorkspaceStore((s) => s.verifyLog);
  const taskAttach = useTaskWorkspaceStore((s) => s.attachListeners);
  const taskReset = useTaskWorkspaceStore((s) => s.reset);

  const shellLog = useShellRunnerStore((s) => s.log);
  const shellStatus = useShellRunnerStore((s) => s.status);
  const shellHistory = useShellRunnerStore((s) => s.history);
  const shellAttach = useShellRunnerStore((s) => s.attachListeners);
  const shellClear = useShellRunnerStore((s) => s.clearLog);
  const shellRun = useShellRunnerStore((s) => s.run);
  const shellStop = useShellRunnerStore((s) => s.stop);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [input, setInput] = useState("");
  const [historyIdx, setHistoryIdx] = useState(-1);

  // Wire all sources on mount so the console captures activity even if the
  // user hasn't run anything yet through other surfaces.
  useEffect(() => {
    void devAttach();
    void agentAttach();
    void taskAttach();
    void shellAttach();
  }, [devAttach, agentAttach, taskAttach, shellAttach]);

  const merged: TaggedLine[] = useMemo(
    () => [
      ...devLog.map((l) => ({ source: "dev" as const, ...l })),
      ...agentLog.map((l) => ({ source: "agent" as const, ...l })),
      ...verifyLog.map((l) => ({ source: "verify" as const, ...l })),
      ...shellLog.map((l) => ({ source: "shell" as const, ...l })),
    ],
    [devLog, agentLog, verifyLog, shellLog],
  );

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const slack = 16;
    pinnedRef.current =
      el.scrollHeight - el.clientHeight - el.scrollTop < slack;
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [merged.length]);

  const clearAll = () => {
    devClear();
    agentReset();
    taskReset();
    shellClear();
  };

  const submit = () => {
    if (!projectPath) return;
    const cmd = input.trim();
    if (!cmd) return;
    setInput("");
    setHistoryIdx(-1);
    void shellRun(projectPath, cmd);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (shellHistory.length === 0) return;
      const next = Math.min(historyIdx + 1, shellHistory.length - 1);
      setHistoryIdx(next);
      setInput(shellHistory[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx <= 0) {
        setHistoryIdx(-1);
        setInput("");
        return;
      }
      const next = historyIdx - 1;
      setHistoryIdx(next);
      setInput(shellHistory[next]);
    }
  };

  const running = shellStatus === "running";
  const noProject = !projectPath;

  return (
    <div className="flex h-full w-full flex-col">
      {projectPath && (
        <Tooltip label={projectPath} side="bottom">
          <div className="mx-3 mb-1.5 flex w-fit items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.04] px-2 py-1 font-mono text-[10px] text-white/55">
            <Folder size={10} weight="fill" className="text-white/40" />
            <span className="text-white/35">cwd</span>
            <span className="text-white/75">{tildePath}</span>
          </div>
        </Tooltip>
      )}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <div className="flex items-center gap-3 text-[11px]">
          <SourceCount source="dev" count={devLog.length} />
          <SourceCount source="agent" count={agentLog.length} />
          <SourceCount source="verify" count={verifyLog.length} />
          <SourceCount source="shell" count={shellLog.length} />
        </div>
        <Tooltip label="Clear all streams" side="bottom">
          <button
            onClick={clearAll}
            disabled={merged.length === 0}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white/85 disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Clear console"
          >
            <Broom size={14} />
          </button>
        </Tooltip>
      </div>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 font-mono text-[11.5px] leading-[1.5]"
      >
        {merged.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <div className="text-sm text-white/35">
              {projectPath ? `Ready in ${projectName}` : "No console output yet"}
            </div>
            <div className="text-[11px] text-white/25">
              {projectPath
                ? "Type a command below, or run an agent / dev server"
                : "Pick a project to run commands"}
            </div>
            {tildePath && (
              <div className="mt-1 font-mono text-[10px] text-white/25">
                {tildePath}
              </div>
            )}
          </div>
        ) : (
          merged.map((l) => (
            <div
              key={`${l.source}-${l.id}`}
              className={[
                "flex items-start gap-2",
                l.stream === "stderr" ? "text-red-300/85" : "text-white/75",
              ].join(" ")}
            >
              <span
                className={[
                  "shrink-0 select-none text-[10px] uppercase tabular-nums",
                  SOURCE_COLOR[l.source],
                ].join(" ")}
              >
                {l.source.padEnd(6, " ")}
              </span>
              <span className="min-w-0 flex-1 break-all">{l.line || " "}</span>
            </div>
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-white/8 px-3 py-2">
        <Tooltip label={projectPath ?? "No project"} side="top">
          <span className="select-none font-mono text-xs text-fuchsia-400/80">
            {projectName ? (
              <>
                <span className="text-white/45">{projectName}</span>
                <span className="ml-1">$</span>
              </>
            ) : (
              "$"
            )}
          </span>
        </Tooltip>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setHistoryIdx(-1);
          }}
          onKeyDown={handleKey}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          disabled={noProject}
          placeholder={
            noProject
              ? "Pick a project to run commands"
              : running
                ? "Command running — press Stop to interrupt, or type to queue next"
                : "Run a command in your project — npm install, python3 -m http.server 8000, etc."
          }
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-white/85 placeholder:text-white/30 outline-none disabled:cursor-not-allowed"
        />
        {running ? (
          <Tooltip label="Stop command" side="top">
            <button
              onClick={() => void shellStop()}
              className="flex h-7 w-7 items-center justify-center rounded-full text-red-300/90 hover:bg-red-500/15 hover:text-red-200"
              aria-label="Stop running command"
            >
              <Stop size={14} weight="fill" />
            </button>
          </Tooltip>
        ) : (
          <Tooltip label="Run command (⏎)" side="top">
            <button
              onClick={submit}
              disabled={noProject || input.trim().length === 0}
              className="flex h-7 w-7 items-center justify-center rounded-full text-emerald-300/90 hover:bg-emerald-400/15 hover:text-emerald-200 disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Run command"
            >
              <Play size={14} weight="fill" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function SourceCount({ source, count }: { source: SourceTag; count: number }) {
  return (
    <span className={["flex items-center gap-1", SOURCE_COLOR[source]].join(" ")}>
      <span className="text-[8px]">●</span>
      <span className="uppercase tracking-wide">{source}</span>
      <span className="tabular-nums text-white/45">{count}</span>
    </span>
  );
}
