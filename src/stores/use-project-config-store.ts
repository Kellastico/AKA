import { create } from "zustand";
import {
  asAppError,
  DEFAULT_PROJECT_CONFIG,
  loadConfig,
  saveConfig,
  type AppError,
  type ProjectConfig,
} from "../lib/tauri/commands";
import { useAgentsStore } from "./use-agents-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";

// Source of truth for the active project's `.äkä/config.json`. Every selector
// in the app (LLM, agent, mode, verify command, max retries) reads from here
// and writes back through `update*` — each setter immediately saves so no
// state is ever lost between project switches.

const blankFor = (projectPath: string): ProjectConfig => ({
  ...DEFAULT_PROJECT_CONFIG,
  runtime: { ...DEFAULT_PROJECT_CONFIG.runtime },
  agent: { ...DEFAULT_PROJECT_CONFIG.agent, args: [], dry_run_flags: [] },
  sandbox: { project_path: projectPath },
});

type ProjectConfigState = {
  /** Path of the project whose config is loaded, or null when no project is open. */
  projectPath: string | null;
  config: ProjectConfig | null;
  loading: boolean;
  /**
   * Last load/save failure as an AppError (typically `ConfigCorrupted`). The
   * task-workspace surfaces this through ErrorBanner with a Reset action.
   */
  error: AppError | null;
  /**
   * Switch to a different project: persist the currently-loaded config first
   * (no unsaved selector state can survive), then load the new one. Pass null
   * to clear.
   */
  switchProject: (next: string | null) => Promise<void>;
  /** Hard-reload from disk for the current project (no persist of in-memory). */
  reload: () => Promise<void>;
  /**
   * Overwrite the on-disk config with defaults — the escape hatch when
   * `.äkä/config.json` won't parse. Clears `error` on success.
   */
  resetToDefaults: () => Promise<void>;

  // Setters — each updates in-memory and immediately calls saveConfig. Never
  // batched, never debounced.
  setRuntimeBaseUrl: (baseUrl: string) => Promise<void>;
  setRuntimeModel: (model: string) => Promise<void>;
  setRuntimeApiKey: (apiKey: string | null) => Promise<void>;
  setAgent: (agent: Partial<ProjectConfig["agent"]>) => Promise<void>;
  setMode: (mode: string) => Promise<void>;
  setVerifyCmd: (cmd: string) => Promise<void>;
  setMaxRetries: (n: number) => Promise<void>;
};

/**
 * Mirror the user's currently-selected global agent + runtime into the loaded
 * project config when the on-disk file is missing those values. Returns the
 * patched config when changes were applied, or `null` when nothing needed
 * filling in — caller uses the null vs object to decide whether to flush
 * back to disk.
 *
 * Only fills empty slots. Never overwrites a value the user has already set
 * on this project — if `agent.bin` is non-empty, we leave the entire agent
 * block alone, even if the user has a different global agent selected now.
 * Same rule for the runtime block: don't second-guess an existing model.
 *
 * This is the auto-heal path for projects imported before addProject learned
 * to scaffold .äkä/config.json. New imports go through buildSeededConfig in
 * use-projects-store and arrive here already populated.
 */
function healFromGlobals(cfg: ProjectConfig): ProjectConfig | null {
  const ag = useAgentsStore.getState();
  const rt = useRuntimeStore.getState();

  let changed = false;
  const next: ProjectConfig = { ...cfg };

  if (!cfg.agent.bin.trim()) {
    // Prefer the explicitly selected agent, but fall back to the first
    // registered agent that actually has a bin (skipping the blank "Custom
    // script" escape hatch), preferring an installed one. This keeps a project
    // from being left with an empty agent.bin when the selection isn't ready
    // yet (startup race) or happens to point at the blank entry — which is what
    // produced the "this project has no agent saved" dead-end.
    const selected = ag.agents.find((x) => x.id === ag.selectedAgentId);
    const candidate =
      (selected?.bin ? selected : undefined) ??
      ag.agents.find((x) => x.bin && x.installed) ??
      ag.agents.find((x) => x.bin);
    if (candidate?.bin) {
      next.agent = {
        ...cfg.agent,
        name: candidate.name,
        bin: candidate.bin,
        args: [...candidate.args],
      };
      changed = true;
    }
  }

  // Runtime block: only fill in pieces that are blank, so a project that
  // intentionally overrides only the model (and uses the default base_url)
  // is left intact.
  const runtimePatch = { ...cfg.runtime };
  let runtimeChanged = false;
  if (!cfg.runtime.model && rt.selectedModelId) {
    runtimePatch.model = rt.selectedModelId;
    runtimeChanged = true;
  }
  if (
    rt.active &&
    cfg.runtime.base_url === DEFAULT_PROJECT_CONFIG.runtime.base_url &&
    rt.active.baseUrl !== DEFAULT_PROJECT_CONFIG.runtime.base_url
  ) {
    runtimePatch.base_url = rt.active.baseUrl;
    runtimeChanged = true;
  }
  if (rt.active && cfg.runtime.api_key == null && rt.active.apiKey) {
    runtimePatch.api_key = rt.active.apiKey;
    runtimeChanged = true;
  }
  if (runtimeChanged) {
    next.runtime = runtimePatch;
    changed = true;
  }

  return changed ? next : null;
}

/**
 * Stable JSON serialisation for the deep-equality check below. Every
 * setter in this store builds `next` via spread from `config`, which
 * preserves key order, so a literal stringify is fine for a config
 * this small.
 */
function configEqual(a: ProjectConfig, b: ProjectConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function persist(
  set: (s: Partial<ProjectConfigState>) => void,
  projectPath: string,
  next: ProjectConfig,
): Promise<void> {
  // Idempotency guard. Setters fire on every selectAgent / selectModel /
  // session-restore call regardless of whether anything actually
  // changed. Writing identical bytes to `.äkä/config.json` still counts
  // as a file modification to any watcher (Vite, fsevents, an IDE,
  // your dotfiles syncer) — so a self-hosting AKA fork that opens the
  // AKA repo as a project would otherwise hit an infinite reload loop
  // on every boot (write → watcher fires → reload → boot writes again).
  // Skipping the no-op write breaks the loop cleanly AND avoids a
  // pointless disk round-trip in the common case.
  const prev = useProjectConfigStore.getState().config;
  if (prev && configEqual(prev, next)) return;

  set({ config: next });
  try {
    await saveConfig(projectPath, next);
  } catch (err) {
    set({ error: asAppError(err) });
  }
}

export const useProjectConfigStore = create<ProjectConfigState>((set, get) => ({
  projectPath: null,
  config: null,
  loading: false,
  error: null,

  switchProject: async (next) => {
    const { projectPath, config } = get();
    // Save the outgoing project's config first so any pending selector state
    // is captured before we hydrate the incoming one.
    if (projectPath && config) {
      try {
        await saveConfig(projectPath, config);
      } catch {
        // Best-effort — failing to save the outgoing config should not block
        // the user from opening a different project.
      }
    }

    if (!next) {
      set({ projectPath: null, config: null, error: null, loading: false });
      return;
    }

    set({ projectPath: next, loading: true, error: null });
    try {
      const loaded = await loadConfig(next);
      // Stamp the informational sandbox path so the on-disk file knows which
      // project it belongs to. This is purely a hint for humans reading the
      // file — sandbox boundaries come from the active project path.
      let stamped: ProjectConfig = {
        ...loaded,
        sandbox: { project_path: next },
      };
      let dirty = loaded.sandbox?.project_path !== next;

      // Auto-heal legacy projects: if the on-disk config has no agent or no
      // model but the user has globals selected (last-used picks), mirror
      // them in. New projects get this via the addProject scaffold; this
      // branch covers projects imported before that landed, where the file
      // already exists but is full of empty defaults. The runner would
      // otherwise hard-fail on `agent.bin is not configured` even though the
      // user clearly has a working agent picked up in the UI.
      const healed = healFromGlobals(stamped);
      if (healed) {
        stamped = healed;
        dirty = true;
      }

      if (dirty) {
        await saveConfig(next, stamped).catch(() => {});
      }
      set({ config: stamped, loading: false });
    } catch (err) {
      // Surface the AppError verbatim so the workspace banner can offer the
      // "Reset to defaults" action. Keep a blank in-memory config so the
      // rest of the UI can still render selectors.
      set({
        config: blankFor(next),
        loading: false,
        error: asAppError(err),
      });
    }
  },

  reload: async () => {
    const { projectPath } = get();
    if (!projectPath) return;
    try {
      const loaded = await loadConfig(projectPath);
      set({ config: loaded, error: null });
    } catch (err) {
      set({ error: asAppError(err) });
    }
  },

  resetToDefaults: async () => {
    const { projectPath } = get();
    if (!projectPath) return;
    const fresh = blankFor(projectPath);
    try {
      await saveConfig(projectPath, fresh);
      set({ config: fresh, error: null });
    } catch (err) {
      set({ error: asAppError(err) });
    }
  },

  setRuntimeBaseUrl: async (baseUrl) => {
    const { projectPath, config } = get();
    if (!projectPath || !config) return;
    const next = { ...config, runtime: { ...config.runtime, base_url: baseUrl } };
    await persist(set, projectPath, next);
  },

  setRuntimeModel: async (model) => {
    const { projectPath, config } = get();
    if (!projectPath || !config) return;
    const next = { ...config, runtime: { ...config.runtime, model } };
    await persist(set, projectPath, next);
  },

  setRuntimeApiKey: async (apiKey) => {
    const { projectPath, config } = get();
    if (!projectPath || !config) return;
    const next = { ...config, runtime: { ...config.runtime, api_key: apiKey } };
    await persist(set, projectPath, next);
  },

  setAgent: async (patch) => {
    const { projectPath, config } = get();
    if (!projectPath || !config) return;
    const next = { ...config, agent: { ...config.agent, ...patch } };
    await persist(set, projectPath, next);
  },

  setMode: async (mode) => {
    const { projectPath, config } = get();
    if (!projectPath || !config) return;
    const next = { ...config, mode };
    await persist(set, projectPath, next);
  },

  setVerifyCmd: async (cmd) => {
    const { projectPath, config } = get();
    if (!projectPath || !config) return;
    const next = { ...config, agent: { ...config.agent, verify_cmd: cmd } };
    await persist(set, projectPath, next);
  },

  setMaxRetries: async (n) => {
    const { projectPath, config } = get();
    if (!projectPath || !config) return;
    const next = { ...config, max_retries: n };
    await persist(set, projectPath, next);
  },
}));
