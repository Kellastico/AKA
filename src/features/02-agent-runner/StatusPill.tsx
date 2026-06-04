import {
  CircleDashed,
  Spinner,
  CheckCircle,
  XCircle,
  Stop,
  type Icon,
} from "@phosphor-icons/react";
import type { RunStatus } from "./use-agent-runner-store";

const styles: Record<RunStatus, { label: string; cls: string; Icon: Icon }> = {
  idle: {
    label: "Idle",
    cls: "bg-white/5 text-white/60 border-white/10",
    Icon: CircleDashed,
  },
  running: {
    label: "Running",
    cls: "bg-sky-500/15 text-sky-200 border-sky-400/30",
    Icon: Spinner,
  },
  passed: {
    label: "Passed",
    cls: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
    Icon: CheckCircle,
  },
  failed: {
    label: "Failed",
    cls: "bg-rose-500/15 text-rose-200 border-rose-400/30",
    Icon: XCircle,
  },
  cancelled: {
    label: "Cancelled",
    cls: "bg-white/10 text-white/70 border-white/20",
    Icon: Stop,
  },
};

export function StatusPill({ status }: { status: RunStatus }) {
  const { label, cls, Icon } = styles[status];
  const spinning = status === "running";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        cls,
      ].join(" ")}
    >
      <Icon size={14} weight="bold" />
      <span className={spinning ? "animate-pulse" : ""}>{label}</span>
    </span>
  );
}
