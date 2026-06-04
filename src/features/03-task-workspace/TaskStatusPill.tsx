import {
  CircleDashed,
  Spinner,
  CheckCircle,
  XCircle,
  ShieldCheck,
  type Icon,
} from "@phosphor-icons/react";
import type { TaskStatus } from "./use-task-workspace-store";

type Style = {
  label: string;
  cls: string;
  Icon: Icon;
  spin?: boolean;
};

const styles: Record<TaskStatus, Style> = {
  idle: {
    label: "Idle",
    cls: "bg-white/5 text-white/60 border-white/10",
    Icon: CircleDashed,
  },
  running: {
    label: "Running",
    cls: "bg-sky-500/15 text-sky-200 border-sky-400/30",
    Icon: Spinner,
    spin: true,
  },
  verifying: {
    label: "Verifying",
    cls: "bg-violet-500/15 text-violet-200 border-violet-400/30",
    Icon: ShieldCheck,
    spin: true,
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
};

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  const { label, cls, Icon, spin } = styles[status];
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        cls,
      ].join(" ")}
    >
      <Icon size={14} weight="bold" />
      <span className={spin ? "animate-pulse" : ""}>{label}</span>
    </span>
  );
}
