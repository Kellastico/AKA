import { ArrowsClockwise, Lock } from "@phosphor-icons/react";
import { useAgentsStore } from "../../stores/use-agents-store";

export function AgentSelector() {
  const agents = useAgentsStore((s) => s.agents);
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId);
  const selectAgent = useAgentsStore((s) => s.selectAgent);
  const refresh = useAgentsStore((s) => s.refresh);
  const refreshing = useAgentsStore((s) => s.refreshing);

  // The "custom" entry has no `bin` and isn't probed, so exclude it from
  // empty-state accounting — built-ins are what we ask the user to install.
  const builtins = agents.filter((a) => !!a.bin);
  const noBuiltinsInstalled =
    builtins.length > 0 && builtins.every((a) => !a.installed);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {agents.map((a) => {
            const active = a.id === selectedAgentId;
            const disabled = !a.installed && !!a.bin;
            const title = disabled
              ? a.install
                ? `Not installed. Install with: ${a.install}`
                : "Not installed."
              : a.version
                ? `${a.description} · ${a.version}`
                : a.description;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => !disabled && selectAgent(a.id)}
                disabled={disabled}
                className={[
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                  active
                    ? "border-white/30 bg-white/15 text-white"
                    : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white",
                  disabled ? "opacity-40 cursor-not-allowed" : "",
                ].join(" ")}
                title={title}
              >
                {disabled && <Lock size={11} weight="fill" />}
                <span>{a.name}</span>
                {a.installed && a.version && (
                  <span className="font-mono text-[10px] text-white/40">
                    {a.version}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          title="Re-check installed agents"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/70 hover:bg-white/10 disabled:opacity-40"
        >
          <ArrowsClockwise
            size={12}
            weight="bold"
            className={refreshing ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </div>

      {noBuiltinsInstalled && (
        <div className="rounded-md border border-white/10 bg-white/5 p-3 text-xs text-white/70">
          <div className="mb-2 font-medium text-white/90">
            No coding agents found. Install one to get started.
          </div>
          <ul className="space-y-1 font-mono text-[11px] text-white/60">
            {builtins.map((a) => (
              <li key={a.id} className="flex gap-2">
                <span className="w-20 shrink-0 text-white/40">{a.name}</span>
                <span>{a.install ?? "(no install hint)"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
