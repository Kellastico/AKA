import { useEffect, useMemo, useRef, useState } from "react";
import { PencilSimple, Plus, Robot } from "@phosphor-icons/react";
import { Popover } from "../Popover";
import { useAgentsStore, type Agent } from "../../stores/use-agents-store";
import { useActiveSessionRunning } from "../../stores/use-chat-store";
import { useSessionStore } from "../../stores/use-session-store";
import { useMessagesStore } from "../../stores/use-messages-store";
import {
  useCustomAgentsStore,
  type CustomAgent,
} from "../../stores/use-custom-agents-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { CustomAgentPanel } from "../CustomAgentPanel";
import { PickerPillButton } from "./PickerPill";

/**
 * Agent picker — shows ONLY what the user actually has:
 *   - The user's registered agents detected on PATH
 *   - A trailing "+ Add custom agent" entry to register a new one
 *
 * AKA ships no agent catalog and recommends none. If the user hasn't
 * registered any agent yet, the picker is empty and only the add button
 * is shown.
 */
export function AgentPicker({ compact }: { compact?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const [panelEditingId, setPanelEditingId] = useState<string | null>(null);

  const agents = useAgentsStore((s) => s.agents);
  const selectedId = useAgentsStore((s) => s.selectedAgentId);
  const select = useAgentsStore((s) => s.selectAgent);
  const refreshAgents = useAgentsStore((s) => s.refresh);

  const customAgents = useCustomAgentsStore((s) => s.agents);
  const customById = useMemo(
    () => new Map(customAgents.map((c) => [c.id, c])),
    [customAgents],
  );

  const selected = agents.find((a) => a.id === selectedId);
  const running = useActiveSessionRunning();
  // Lock the picker once a session has real messages, EXCEPT when the most
  // recent message is an agent crash. A crash is a recovery state: the user
  // needs to be able to re-select the same agent (to re-verify install) or
  // swap to a different one without being forced into a brand-new session.
  // Any other error kind (LLM offline, sandbox, etc.) keeps the lock — they
  // aren't fixable by changing the agent.
  const lastMessageIsCrash = useMessagesStore((s) => {
    if (s.messages.length === 0) return false;
    return s.messages[s.messages.length - 1].error?.kind === "AgentCrash";
  });
  const sessionLocked = useMessagesStore((s) => {
    if (s.messages.length === 0) return false;
    const last = s.messages[s.messages.length - 1];
    if (last.error?.kind === "AgentCrash") return false;
    return true;
  });

  // When the picker opens after a crash, re-run agent detection so the
  // install statuses are fresh. This makes the "click to retry" gesture
  // work: if the user fixed the missing wrapper / installed the binary
  // between the crash and reopening the picker, the row flips to installed
  // without them having to restart the app.
  useEffect(() => {
    if (open && lastMessageIsCrash) {
      void refreshAgents();
    }
  }, [open, lastMessageIsCrash, refreshAgents]);

  // Visible rows: every registered agent (skip only the blank "Custom Script"
  // escape-hatch entry). We do NOT hide agents that detection couldn't verify
  // on PATH — the user registered them, so they stay selectable and the row
  // just notes "not found on PATH". Hiding them was what made a freshly-added
  // agent look like it "didn't add".
  const visibleAgents = agents.filter((a) => a.id !== "custom" && !!a.bin);

  const switchTo = (agentId: string) => {
    setOpen(false);
    if (agentId === selectedId) return;
    if (sessionLocked) return;
    const previous =
      agents.find((x) => x.id === selectedId)?.name ?? selectedId ?? "(unset)";
    const next = agents.find((x) => x.id === agentId)?.name ?? agentId;
    useSessionStore
      .getState()
      .performHandoff("agent", previous, next, async () => {
        try {
          select(agentId);
        } catch (err) {
          useRuntimeStore.getState().pushToast({
            kind: "error",
            text:
              err instanceof Error
                ? `Couldn't switch agent: ${err.message}`
                : "Couldn't switch agent.",
          });
        }
      })
      .catch((err) => {
        useRuntimeStore.getState().pushToast({
          kind: "error",
          text:
            err instanceof Error
              ? `Agent swap failed: ${err.message}`
              : "Agent swap failed.",
        });
      });
  };

  const openAdd = () => {
    setPanelEditingId(null);
    setShowPanel(true);
  };
  const openEdit = (id: string) => {
    setPanelEditingId(id);
    setShowPanel(true);
  };
  const closePanel = () => {
    setShowPanel(false);
    setPanelEditingId(null);
  };

  const panelEditingAgent: CustomAgent | null =
    panelEditingId ? (customById.get(panelEditingId) ?? null) : null;

  return (
    <>
      <PickerPillButton
        buttonRef={ref}
        icon={<Robot size={14} />}
        label={selected?.name ?? "Select agent"}
        open={open}
        compact={compact}
        disabled={running}
        disabledTitle="Wait for the response to finish, or press Stop, before switching agents."
        sessionLocked={sessionLocked}
        onClick={() => setOpen((v) => !v)}
      />

      <Popover
        open={open}
        onClose={() => { setOpen(false); closePanel(); }}
        anchorRef={ref}
        width={showPanel ? 300 : 288}
      >
        {showPanel ? (
          <CustomAgentPanel
            editing={panelEditingAgent}
            onDone={closePanel}
          />
        ) : (
          <>
            {visibleAgents.length === 0 ? (
              <div className="px-3 py-3 text-xs text-white/55">
                No agents registered yet. Add the agent you use below — AKA
                detects it on your PATH and runs it.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {visibleAgents.map((a) => (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    selected={a.id === selectedId}
                    isCustom={customById.has(a.id)}
                    onPick={() => switchTo(a.id)}
                    onEdit={() => openEdit(a.id)}
                  />
                ))}
              </div>
            )}

            <div className="my-1 h-px bg-white/8" />

            <button
              onClick={openAdd}
              className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-fuchsia-200/85 transition-colors hover:bg-fuchsia-500/10 hover:text-fuchsia-100"
            >
              <Plus size={14} weight="bold" />
              Add custom agent
            </button>
          </>
        )}
      </Popover>
    </>
  );
}

/**
 * One row in the agent dropdown. Every agent is user-registered, so each row
 * gets a hover-revealed pencil icon for editing its saved config.
 */
function AgentRow({
  agent,
  selected,
  isCustom,
  onPick,
  onEdit,
}: {
  agent: Agent;
  selected: boolean;
  isCustom: boolean;
  onPick: () => void;
  onEdit: () => void;
}) {
  return (
    <div
      className={[
        "group flex items-center gap-2 rounded-2xl px-3 py-2 transition-colors",
        selected ? "bg-white/12" : "hover:bg-white/8",
      ].join(" ")}
    >
      <button
        onClick={onPick}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="w-full truncate text-sm text-white/90">{agent.name}</span>
        <span
          className={[
            "w-full truncate text-[11px]",
            agent.installed ? "text-white/45" : "text-amber-300/70",
          ].join(" ")}
        >
          {agent.installed
            ? agent.version
              ? `v${agent.version}`
              : agent.description
            : "not found on PATH — will try to launch anyway"}
        </span>
      </button>
      {isCustom && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/40 opacity-0 transition-opacity hover:bg-white/10 hover:text-white/80 group-hover:opacity-100"
          aria-label={`Edit ${agent.name}`}
          title="Edit custom agent"
        >
          <PencilSimple size={11} />
        </button>
      )}
    </div>
  );
}
