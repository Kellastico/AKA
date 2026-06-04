import { create } from "zustand";
import {
  detectAgents,
  recheckAgents,
  type DetectedAgent,
} from "../lib/tauri/commands";
import { useProjectConfigStore } from "./use-project-config-store";
import { useCustomAgentsStore, type CustomAgent } from "./use-custom-agents-store";
import { useMessagesStore } from "./use-messages-store";

/** Whether the LLM connection is owned by the agent process or orchestrated by ÄKÄ. */
export type LLMOwnership = "agent" | "aka";

export type Agent = {
  id: string;
  name: string;
  description: string;
  expectedRamMB: number;
  bin: string;
  args: string[];
  install?: string | null;
  installed: boolean;
  version?: string | null;
  verifyCmd?: string | null;
  /**
   * "agent" → external process owns the LLM connection at spawn time (Aider, Claude Code, etc.)
   *   — the Model pill locks alongside the Agent pill once the session starts.
   * "aka" → ÄKÄ orchestrates the LLM and can switch models per-message.
   */
  llmOwnership: LLMOwnership;
};

const CUSTOM_AGENT: Agent = {
  id: "custom",
  name: "Custom script",
  description: "User-defined runner (configure in .äkä/config.json)",
  expectedRamMB: 150,
  bin: "",
  args: [],
  install: null,
  installed: true,
  llmOwnership: "aka",
};

type AgentsState = {
  agents: Agent[];
  selectedAgentId: string;
  initialized: boolean;
  refreshing: boolean;
  lastRefreshedAt: number | null;
  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  selectAgent: (id: string) => void;
  /**
   * Restore the selected agent for the active project from its `.äkä/config.json`.
   * Matches by `agent.bin`. Falls back to the first installed agent when the
   * configured bin isn't known here.
   */
  hydrateFromProject: (bin: string) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
};

// AKA ships no agent catalog, so the picker starts with only the blank
// escape-hatch entry. Real agents are appended once the user's saved agents
// are reconciled (see `reconcile`).
const initialAgents: Agent[] = [CUSTOM_AGENT];

/**
 * Convert a saved CustomAgent into the unified Agent shape, folding in the
 * detection result for its bin. A registered agent counts as `installed` when
 * its bin was found on PATH; when detection is unavailable (browser dev, no
 * Tauri bridge), `detected` is undefined and we trust the registration.
 */
function fromCustomAgent(c: CustomAgent, detected?: DetectedAgent): Agent {
  return {
    id: c.id,
    name: c.name,
    description: `${c.bin}${c.args.length > 0 ? " " + c.args.join(" ") : ""}`,
    expectedRamMB: 150,
    bin: c.bin,
    args: c.args,
    install: null,
    installed: detected?.installed ?? true,
    version: detected?.version ?? null,
    llmOwnership: c.llmOwnership,
  };
}

async function reconcile(
  detectFn: (bins: string[]) => Promise<DetectedAgent[]>,
): Promise<Agent[]> {
  // The only bins AKA probes are the ones the user registered — there is no
  // built-in list to scan. Dedupe so two agents sharing a bin probe once.
  const customs = useCustomAgentsStore.getState().agents;
  const bins = [...new Set(customs.map((c) => c.bin).filter(Boolean))];
  const detected = bins.length > 0 ? await detectFn(bins) : [];
  const detectedMap = new Map<string, DetectedAgent>(
    detected.map((d) => [d.bin, d]),
  );
  // Order: user-saved agents → blank "Custom Script" escape hatch.
  return [
    ...customs.map((c) => fromCustomAgent(c, detectedMap.get(c.bin))),
    CUSTOM_AGENT,
  ];
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: initialAgents,
  selectedAgentId: initialAgents[0]?.id ?? "custom",
  initialized: false,
  refreshing: false,
  lastRefreshedAt: null,

  bootstrap: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    try {
      const next = await reconcile(detectAgents);
      const firstInstalled = next.find((a) => a.installed && a.bin);
      set({
        agents: next,
        selectedAgentId: firstInstalled?.id ?? next[0].id,
        lastRefreshedAt: Date.now(),
      });
    } catch {
      // Browser fallback already in place.
    }
  },

  refresh: async () => {
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const next = await reconcile(recheckAgents);
      // Preserve the user's current selection — detection is advisory, never
      // auto-switches the active agent.
      set({ agents: next, lastRefreshedAt: Date.now() });
    } catch {
      // ignore — UI keeps prior state
    } finally {
      set({ refreshing: false });
    }
  },

  selectAgent: (id) => {
    set({ selectedAgentId: id });
    const a = get().agents.find((x) => x.id === id);
    if (!a) return;
    // Mirror to the active session's meta so swapping sessions restores the
    // pill (per-session agent attachment). Sessions without meta inherit the
    // current selection on creation — "last-used sticks".
    const { currentSessionId, setSessionMeta } = useMessagesStore.getState();
    if (currentSessionId) {
      setSessionMeta(currentSessionId, { agentId: id });
    }
    // Also mirror into the project config so it survives restarts AND acts
    // as the default for fresh projects that have no session meta yet.
    void useProjectConfigStore.getState().setAgent({
      name: a.name,
      bin: a.bin,
      args: a.args,
    });
  },
  hydrateFromProject: (bin) => {
    if (!bin) return;
    const { agents, selectedAgentId } = get();
    // Already pointing at an agent with this bin? No-op. This prevents the
    // flicker where:
    //   1. user picks a custom agent → selectAgent() sets selectedAgentId synchronously
    //   2. setAgent() persists config async; React re-renders
    //   3. the agentBin effect re-fires hydrateFromProject() with the new bin
    //   4. find() returns a *different* agent that happens to share the bin
    //      (e.g. the user has two python-based custom agents), bouncing the
    //      pill back to the wrong one mid-selection.
    // By honouring the existing selection when it already matches the bin we
    // make the round-trip a true no-op.
    const current = agents.find((a) => a.id === selectedAgentId);
    if (current && current.bin === bin) return;
    const match = agents.find((a) => a.bin === bin);
    if (match) {
      set({ selectedAgentId: match.id });
    }
  },
  updateAgent: (id, patch) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),
}));
