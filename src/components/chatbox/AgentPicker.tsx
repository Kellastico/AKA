import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  PencilSimple,
  Plus,
  Prohibit,
  Robot,
  Star,
} from "@phosphor-icons/react";

/** Show the search box once the agent list grows past this. */
const SEARCH_THRESHOLD = 10;
import { Popover } from "../Popover";
import {
  NONE_AGENT,
  useAgentsStore,
  type Agent,
} from "../../stores/use-agents-store";
import { useActiveSessionRunning } from "../../stores/use-chat-store";
import { useSessionStore } from "../../stores/use-session-store";
import {
  useMessagesStore,
  useActiveSessionPosture,
} from "../../stores/use-messages-store";
import {
  classifyModel,
  POSTURE_ORDER,
  POSTURE_LABEL,
  POSTURE_BLURB,
  type Posture,
} from "../../lib/model-posture";
import {
  useCustomAgentsStore,
  type CustomAgent,
} from "../../stores/use-custom-agents-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { usePrefsStore } from "../../stores/use-prefs-store";
import { CustomAgentPanel } from "../CustomAgentPanel";
import { PickerPillButton, PickerSearchInput } from "./PickerPill";

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
  // Filter query for the agent list — only surfaced for long lists.
  const [query, setQuery] = useState("");

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
  const q = query.trim().toLowerCase();
  const filteredAgents = q
    ? visibleAgents.filter((a) => a.name.toLowerCase().includes(q))
    : visibleAgents;

  // Reset the search each time the picker closes so it reopens clean.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

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
            {/* "None" — no agent subprocess; AKA relays to the model. Always
                offered, above any registered agents, for ICM/SAFE-style setups
                where the agentic layer lives on the model side. */}
            <NoneRow
              selected={selectedId === NONE_AGENT.id}
              onPick={() => switchTo(NONE_AGENT.id)}
            />

            {visibleAgents.length === 0 ? (
              <div className="px-3 py-3 text-xs text-white/55">
                No agents registered yet. Pick “None” to run the model directly,
                or add the agent you use below — AKA detects it on your PATH and
                runs it.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {visibleAgents.length > SEARCH_THRESHOLD && (
                  <PickerSearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search agents…"
                  />
                )}
                {filteredAgents.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-white/45">
                    No agents match “{query.trim()}”.
                  </div>
                ) : (
                  filteredAgents.map((a) => (
                    <AgentRow
                      key={a.id}
                      agent={a}
                      selected={a.id === selectedId}
                      isCustom={customById.has(a.id)}
                      onPick={() => switchTo(a.id)}
                      onEdit={() => openEdit(a.id)}
                    />
                  ))
                )}
              </div>
            )}

            <div className="my-1 h-px bg-white/8" />

            <PostureSpectrum
              agentIsNone={selectedId === NONE_AGENT.id}
              locked={sessionLocked}
              onPickNone={() => switchTo(NONE_AGENT.id)}
            />

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
 * The "None" row — selecting it means no agent subprocess; AKA talks to the
 * model directly. Visually set apart from registered agents (its own icon, no
 * edit affordance) so it reads as a mode of operation, not a tool to install.
 */
function NoneRow({
  selected,
  onPick,
}: {
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className={[
        "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left transition-colors",
        selected ? "bg-white/12" : "hover:bg-white/8",
      ].join(" ")}
    >
      <Prohibit size={14} className="shrink-0 text-white/55" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-white/90">{NONE_AGENT.name}</span>
        <span className="truncate text-[11px] text-white/45">
          {POSTURE_BLURB.none}
        </span>
      </div>
      {selected && <Check size={13} className="shrink-0 text-white/70" />}
    </button>
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

/**
 * The posture spectrum — the thin↔thick harness dial, ordered None → Light →
 * Tight → Orchestrated. The classifier ({@link classifyModel}) recommends one
 * posture for the selected model; it's shown as an advisory "Recommended" badge
 * and is never forced. None maps to selecting the No-agent option (max autonomy,
 * house safety still on); Light/Tight/Orchestrated set the session's posture
 * override, which the run path emits as the `AGENT_*` env dial to the spawned
 * agent. Host-agnostic: these are intensity levels, not specific agents.
 */
function PostureSpectrum({
  agentIsNone,
  locked,
  onPickNone,
}: {
  agentIsNone: boolean;
  locked: boolean;
  onPickNone: () => void;
}) {
  const selectedModelId = useRuntimeStore((s) => s.selectedModelId);
  const override = useActiveSessionPosture();
  const currentSessionId = useMessagesStore((s) => s.currentSessionId);
  const setSessionMeta = useMessagesStore((s) => s.setSessionMeta);
  const autoApply = usePrefsStore((s) => s.autoApplyPosture);
  const setAutoApply = usePrefsStore((s) => s.setAutoApplyPosture);

  const cap = classifyModel(selectedModelId);
  // The active posture: None when the No-agent option is picked, otherwise the
  // explicit override or — advisory — the model's recommendation.
  const active: Posture = agentIsNone ? "none" : (override ?? cap.recommended);

  const pick = (p: Posture) => {
    if (locked) return;
    if (p === "none") {
      onPickNone();
      return;
    }
    if (currentSessionId) setSessionMeta(currentSessionId, { posture: p });
  };

  return (
    <div className="px-1 py-1">
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-white/45">
          Harness posture
        </span>
        <span className="text-[10px] text-white/35">
          {selectedModelId ? `for ${selectedModelId}` : "no model"}
        </span>
      </div>
      <div className="flex gap-1">
        {POSTURE_ORDER.map((p) => {
          const isActive = active === p;
          const isRecommended = cap.recommended === p;
          return (
            <button
              key={p}
              onClick={() => pick(p)}
              disabled={locked}
              title={POSTURE_BLURB[p]}
              className={[
                "relative flex-1 rounded-xl px-2 py-1.5 text-[11px] transition-colors",
                isActive
                  ? "bg-fuchsia-500/20 text-fuchsia-100 ring-1 ring-fuchsia-400/40"
                  : "text-white/70 hover:bg-white/8",
                locked ? "cursor-not-allowed opacity-50" : "",
              ].join(" ")}
            >
              {POSTURE_LABEL[p]}
              {isRecommended && (
                <Star
                  size={9}
                  weight="fill"
                  className="ml-1 inline align-middle text-amber-300/80"
                  aria-label="recommended"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="px-2 pt-1 text-[11px] text-white/45">
        {POSTURE_BLURB[active]}
        {!agentIsNone && active === cap.recommended && (
          <span className="text-white/35"> · recommended for this model</span>
        )}
      </div>
      <label className="mt-1 flex cursor-pointer items-center gap-1.5 px-2 text-[11px] text-white/45 hover:text-white/70">
        <input
          type="checkbox"
          checked={autoApply}
          onChange={(e) => void setAutoApply(e.target.checked)}
          className="h-3 w-3 accent-fuchsia-500"
        />
        Auto-apply recommendation on model change
      </label>
    </div>
  );
}
