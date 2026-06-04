import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  Check,
  Plus,
  Robot,
} from "@phosphor-icons/react";
import { useAgentsStore } from "../../stores/use-agents-store";
import { useFirstRunStore } from "../../stores/use-first-run-store";
import { CustomAgentPanel } from "../CustomAgentPanel";

/**
 * Detect the user's registered agents on PATH and let them pick one — or
 * register a new agent inline. AKA ships no agent catalog and recommends none:
 * you bring whichever agent you use and AKA orchestrates it. Detection probes
 * exactly the bins the user has registered.
 */
export function AgentStep() {
  const next = useFirstRunStore((s) => s.next);

  const agents = useAgentsStore((s) => s.agents);
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId);
  const refreshing = useAgentsStore((s) => s.refreshing);
  const refresh = useAgentsStore((s) => s.refresh);
  const selectAgent = useAgentsStore((s) => s.selectAgent);

  const [adding, setAdding] = useState(false);

  // Re-probe PATH when the user lands here — an agent registered via the
  // panel below shows up as soon as its bin resolves.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installed = agents.filter((a) => a.installed && a.bin);
  const hasInstalled = installed.length > 0;

  const selected = agents.find((a) => a.id === selectedAgentId);
  const canContinue =
    !!selected && (selected.installed || selected.id === "custom");

  return (
    <div className="flex flex-col gap-6">
      <Header
        title="Pick a coding agent"
        subtitle="Agents are the programs that actually edit files and run tools. AKA orchestrates them — you bring the agent."
      />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Detected on your PATH</SectionLabel>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1 text-[11px] text-white/55 hover:text-white disabled:opacity-50"
          >
            <ArrowClockwise
              size={11}
              className={refreshing ? "animate-spin" : ""}
            />
            {refreshing ? "Scanning…" : "Rescan"}
          </button>
        </div>

        {hasInstalled &&
          installed.map((a) => {
            const isSelected = a.id === selectedAgentId;
            return (
              <button
                key={a.id}
                onClick={() => selectAgent(a.id)}
                className={[
                  "flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                  isSelected
                    ? "border-emerald-400/40 bg-emerald-400/8"
                    : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]",
                ].join(" ")}
              >
                <div className="flex items-center gap-2.5">
                  <Robot size={18} weight="duotone" className="text-fuchsia-300/80" />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{a.name}</span>
                    <span className="font-mono text-[11px] text-white/45">
                      {a.version ? `v${a.version}` : a.bin}
                    </span>
                  </div>
                </div>
                {isSelected && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                    <Check size={11} weight="bold" />
                    Selected
                  </span>
                )}
              </button>
            );
          })}

        {!hasInstalled && !adding && <EmptyState onAdd={() => setAdding(true)} />}

        {adding ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-2 py-2">
            <CustomAgentPanel onDone={() => setAdding(false)} />
          </div>
        ) : hasInstalled ? (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 self-start rounded-full px-3 py-1.5 text-[12px] text-fuchsia-200/85 transition-colors hover:bg-fuchsia-500/10 hover:text-fuchsia-100"
          >
            <Plus size={12} weight="bold" />
            Add another agent
          </button>
        ) : null}
      </div>

      <p className="text-[11px] text-white/35">
        You can always switch agents later from the pill in the chat input.
      </p>

      <div className="flex items-center justify-end pt-2">
        <button
          onClick={next}
          disabled={!canContinue}
          className="inline-flex items-center gap-2 rounded-full bg-fuchsia-500/90 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-fuchsia-400 disabled:bg-white/10 disabled:text-white/35"
        >
          Continue
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>
    </div>
  );
}

/**
 * Neutral empty state. AKA doesn't ship or recommend any agent, so when none
 * are detected we explain the model and offer to register one — no install
 * command, no named default.
 */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-fuchsia-400/25 bg-fuchsia-500/[0.06] px-4 py-4">
      <div className="flex items-start gap-3">
        <Robot size={20} weight="duotone" className="mt-0.5 shrink-0 text-fuchsia-300" />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-white">
            No agents found on your PATH
          </span>
          <span className="text-[12px] text-white/65">
            AKA doesn't ship or recommend an agent — you bring your own. Register
            the agent you use (its command and arguments) and AKA will detect and
            run it.
          </span>
        </div>
      </div>

      <button
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 self-start rounded-full bg-fuchsia-500/90 px-4 py-2 text-[12px] font-medium text-white hover:bg-fuchsia-400"
      >
        <Plus size={12} weight="bold" />
        Add your agent
      </button>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="text-sm text-white/55">{subtitle}</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
      {children}
    </span>
  );
}
