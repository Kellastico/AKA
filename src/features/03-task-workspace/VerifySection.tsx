import { CaretRight, CaretDown, ShieldCheck } from "@phosphor-icons/react";
import { LogView } from "../02-agent-runner/LogView";
import { useTaskWorkspaceStore } from "./use-task-workspace-store";

export function VerifySection() {
  const verifyLog = useTaskWorkspaceStore((s) => s.verifyLog);
  const verifyExitCode = useTaskWorkspaceStore((s) => s.verifyExitCode);
  const expanded = useTaskWorkspaceStore((s) => s.verifyExpanded);
  const setExpanded = useTaskWorkspaceStore((s) => s.setVerifyExpanded);
  const status = useTaskWorkspaceStore((s) => s.status);

  const isVerifying = status === "verifying";
  const Caret = expanded ? CaretDown : CaretRight;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-white/10 bg-black/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-white/70 hover:text-white"
      >
        <span className="inline-flex items-center gap-1.5">
          <Caret size={12} weight="bold" />
          <ShieldCheck size={12} weight="bold" />
          Verification
          {isVerifying && (
            <span className="animate-pulse text-violet-300/90">· running…</span>
          )}
          {verifyLog.length > 0 && (
            <span className="text-white/40">· {verifyLog.length} lines</span>
          )}
        </span>
        {verifyExitCode !== null && (
          <span
            className={
              verifyExitCode === 0
                ? "font-mono text-emerald-300/90"
                : "font-mono text-rose-300/90"
            }
          >
            exit {verifyExitCode}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2">
          <div className="h-48">
            <LogView
              lines={verifyLog}
              empty="No verification output yet."
            />
          </div>
        </div>
      )}
    </div>
  );
}
