import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  checkRuntimeHealth,
  detectRuntimes,
  getHardwareProfile,
  getSidecarStatus,
  listRuntimeModels,
  restartRuntime,
  type DetectedRuntime,
  type HardwareProfile,
  type SidecarStatusValue,
} from "../../lib/tauri/commands";
import { useProjectConfigStore } from "../../stores/use-project-config-store";
import { useMessagesStore } from "../../stores/use-messages-store";
import { findBestModelMatch } from "../../lib/model-match";

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const HEALTH_INTERVAL_MS = 30_000;
/**
 * How often to silently re-probe local ports so the detected-runtimes list
 * updates on its own (no manual Refresh needed). Probes are cheap loopback
 * requests, so a short interval is fine.
 */
const DETECT_INTERVAL_MS = 5_000;

const hasTauri = () => "__TAURI_INTERNALS__" in window;

/** Stable id/name for the built-in runtime entry. */
export const BUILTIN_RUNTIME_ID = "aka-builtin";
export const BUILTIN_RUNTIME_NAME = "ÄKÄ Built-in";

/** OpenAI-compatible base URL for the sidecar on a resolved port. */
export function builtinEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * Friendly name of the currently-active runtime, for the top-bar pill
 * ("Runtime · Ollama", "Runtime · ÄKÄ Built-in", …). Resolves in order:
 * built-in sidecar → a matching detected runtime → the host of a custom
 * endpoint. Returns null when nothing is configured yet.
 */
export function activeRuntimeName(s: RuntimeState): string | null {
  const { active, detected, builtinPort } = s;
  if (!active?.baseUrl) return null;
  if (builtinPort != null && active.baseUrl === builtinEndpoint(builtinPort)) {
    return BUILTIN_RUNTIME_NAME;
  }
  const match = detected.find((d) => d.baseUrl === active.baseUrl);
  if (match) return match.name;
  try {
    return new URL(active.baseUrl).host;
  } catch {
    return "Custom";
  }
}

export type RuntimeConfig = {
  baseUrl: string;
  apiKey: string | null;
};

export type Toast = {
  id: number;
  /**
   * Drives the toast's color: success = green, danger = red (destructive, e.g.
   * deleted/rejected), error = red (failure), warning = amber, info = neutral.
   */
  kind: "danger" | "error" | "info" | "success" | "warning";
  text: string;
};

type RuntimeState = {
  initialized: boolean;
  detected: DetectedRuntime[];
  detecting: boolean;
  active: RuntimeConfig | null;
  healthy: boolean;
  models: string[];
  loadingModels: boolean;
  modelsError: string | null;
  selectedModelId: string | null;
  /**
   * Last model the user actively selected on each runtime, keyed by base URL.
   * Lets a runtime switch restore the model you last ran there (round-trips
   * between runtimes stay seamless). In-memory — resets on app restart.
   */
  lastModelByRuntime: Record<string, string>;
  /**
   * Bumped whenever a runtime switch leaves the session with no valid model and
   * no confident remap, so the ModelPicker can pop itself open and prompt for a
   * choice instead of silently stranding the user on "Select a model".
   */
  pickModelNudge: number;
  toasts: Toast[];

  // Built-in (managed) runtime — the bundled sidecar. `builtinPort` is read
  // dynamically from the backend; never hardcoded. Status is driven by the
  // `runtime:ready` / `runtime:restarting` / `runtime:failed` events.
  builtinStatus: SidecarStatusValue;
  builtinPort: number | null;
  builtinError: string | null;
  hardware: HardwareProfile | null;

  // Whether the runtime settings panel (ConnectionPanel) is open. The panel
  // now lives in the TopBar; this flag lets other surfaces (e.g. the model
  // picker's "pick another" link) open it too.
  runtimePanelOpen: boolean;
  setRuntimePanelOpen: (open: boolean) => void;

  bootstrap: () => Promise<void>;
  /**
   * Re-probe local ports for OpenAI-compatible runtimes. Pass `{ silent: true }`
   * for the background poller so the "Probing…" spinner/disabled state is not
   * toggled on every tick — only an explicit user Refresh shows that.
   */
  refreshDetection: (opts?: { silent?: boolean }) => Promise<void>;
  /** Fetch initial sidecar status + hardware, then subscribe to lifecycle events. */
  initBuiltin: () => Promise<void>;
  /** Select the built-in runtime as the active runtime for the open project. */
  selectBuiltin: () => Promise<void>;
  /** User-initiated restart of the built-in runtime. */
  restartBuiltin: () => Promise<void>;
  selectDetected: (runtime: DetectedRuntime) => Promise<void>;
  saveManual: (baseUrl: string, apiKey: string | null) => Promise<{ ok: boolean; error?: string }>;
  selectModel: (modelId: string) => Promise<void>;
  /**
   * Hydrate from the active project's config. Called by AppShell whenever the
   * project switches — the runtime block in `.äkä/config.json` is the source
   * of truth.
   */
  hydrateFromProject: (
    cfg: { baseUrl: string; model: string; apiKey: string | null } | null,
  ) => Promise<void>;
  pushToast: (toast: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
};

let healthTimer: ReturnType<typeof setInterval> | null = null;
let detectTimer: ReturnType<typeof setInterval> | null = null;
let toastSeq = 1;

async function refreshModels(
  set: (s: Partial<RuntimeState>) => void,
  get: () => RuntimeState,
  active: RuntimeConfig,
) {
  set({ loadingModels: true, modelsError: null });
  try {
    const models = await listRuntimeModels(active.baseUrl, active.apiKey ?? null);
    // Reconcile the selected model against what this runtime actually serves.
    // A model carried over from another runtime (or a stale project config)
    // must not linger in the chatbox when the active runtime doesn't offer it.
    // But rather than silently null it out and strand the session, we try in
    // order: keep it (still valid) → restore what was last used on THIS runtime
    // → remap to the closest equivalent name → finally give up and prompt.
    const prev = get().selectedModelId;
    let next: string | null = null;
    let note: string | null = null;

    if (prev != null && models.includes(prev)) {
      next = prev; // exact selection still served here
    } else if (prev != null) {
      const remembered = get().lastModelByRuntime[active.baseUrl];
      if (remembered && models.includes(remembered)) {
        // (B) Per-runtime memory — restore what you last ran on this runtime.
        next = remembered;
        if (remembered !== prev) note = `Switched to ${remembered} on this runtime.`;
      } else {
        // (A) Fuzzy remap across naming schemes (GGUF filename ↔ Ollama tag).
        const match = findBestModelMatch(prev, models);
        if (match) {
          next = match;
          note = `"${prev}" isn't on this runtime — switched to ${match}.`;
        } else {
          next = null;
          note = `"${prev}" isn't available here — pick a model to continue this session.`;
        }
      }
    }

    set({ models, loadingModels: false, selectedModelId: next });

    if (next) {
      // Persist an auto-resolved pick and remember it for this runtime.
      if (next !== prev) void useProjectConfigStore.getState().setRuntimeModel(next);
      set({ lastModelByRuntime: { ...get().lastModelByRuntime, [active.baseUrl]: next } });
    } else if (prev != null) {
      // We had a model and lost it with no confident replacement — nudge the
      // picker open so the user isn't left hunting for why sending is blocked.
      set({ pickModelNudge: get().pickModelNudge + 1 });
    }
    if (note) get().pushToast({ kind: "info", text: note });
  } catch (err) {
    set({
      models: [],
      loadingModels: false,
      modelsError: err instanceof Error ? err.message : String(err),
    });
  }
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  initialized: false,
  detected: [],
  detecting: false,
  active: null,
  healthy: false,
  models: [],
  loadingModels: false,
  modelsError: null,
  selectedModelId: null,
  lastModelByRuntime: {},
  pickModelNudge: 0,
  toasts: [],

  builtinStatus: "stopped",
  builtinPort: null,
  builtinError: null,
  hardware: null,
  runtimePanelOpen: false,

  setRuntimePanelOpen: (runtimePanelOpen) => set({ runtimePanelOpen }),

  bootstrap: async () => {
    if (get().initialized) return;
    set({ initialized: true });

    // No project open yet — start with a blank in-memory runtime. The
    // per-project config hydrates as soon as the user opens a project.
    set({
      active: { baseUrl: DEFAULT_BASE_URL, apiKey: null },
      selectedModelId: null,
    });

    await get().initBuiltin();
    await get().refreshDetection();

    // Keep the detected-runtimes list live without a manual Refresh. Only runs
    // under Tauri (the probe is a backend command); silent so it never flashes
    // the "Probing…" state on each tick.
    if (detectTimer) clearInterval(detectTimer);
    if (hasTauri()) {
      detectTimer = setInterval(() => {
        void get().refreshDetection({ silent: true });
      }, DETECT_INTERVAL_MS);
    }

    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(async () => {
      const cur = get().active;
      if (!cur?.baseUrl) return;
      const wasHealthy = get().healthy;
      const nowHealthy = await checkRuntimeHealth(cur.baseUrl, cur.apiKey ?? null);
      if (nowHealthy !== wasHealthy) {
        set({ healthy: nowHealthy });
        if (!nowHealthy && wasHealthy) {
          get().pushToast({
            kind: "error",
            text: "Runtime disconnected — check your LLM server",
          });
        }
        if (nowHealthy && !wasHealthy) {
          await refreshModels(set, get, cur);
        }
      }
    }, HEALTH_INTERVAL_MS);
  },

  refreshDetection: async (opts) => {
    const silent = opts?.silent ?? false;
    if (!silent) set({ detecting: true });
    try {
      const detected = await detectRuntimes();
      set({ detected, detecting: false });
      // Keep the active runtime's health in sync with the live probe so the
      // top-bar pill's dot flips on its own (matching the detected list) —
      // not just on the 30s health tick. Built-in health is driven by
      // lifecycle events; custom endpoints that aren't in the detected list
      // are left to the periodic health check.
      const active = get().active;
      const builtinPort = get().builtinPort;
      const isBuiltin =
        active != null &&
        builtinPort != null &&
        active.baseUrl === builtinEndpoint(builtinPort);
      if (active?.baseUrl && !isBuiltin) {
        const match = detected.find((d) => d.baseUrl === active.baseUrl);
        if (match && match.healthy !== get().healthy) {
          set({ healthy: match.healthy });
          if (match.healthy) {
            // Reconnected — reload models (which also reconciles the selection).
            await refreshModels(set, get, active);
          } else {
            // Disconnected — clear the model list and warn once.
            set({ models: [], modelsError: null });
            get().pushToast({
              kind: "error",
              text: "Runtime disconnected — check your LLM server",
            });
          }
        }
      }
    } catch {
      // Background polls keep the last good list rather than blanking it on a
      // transient probe error; only an explicit refresh clears to empty.
      if (silent) set({ detecting: false });
      else set({ detected: [], detecting: false });
    }
  },

  initBuiltin: async () => {
    // Seed from the backend's current view, then keep it live via events.
    try {
      const status = await getSidecarStatus();
      set({
        builtinStatus: status.status,
        builtinPort: status.port,
        builtinError: status.error,
      });
    } catch {
      // Backend not ready / older binary — leave defaults.
    }
    try {
      set({ hardware: await getHardwareProfile() });
    } catch {
      /* hardware banner is optional */
    }

    if (!hasTauri()) return;
    // Subscriptions live for the app's lifetime; the store is a singleton.
    await listen<number>("runtime:ready", (e) => {
      set({
        builtinStatus: "ready",
        builtinPort: typeof e.payload === "number" ? e.payload : get().builtinPort,
        builtinError: null,
      });
    });
    await listen("runtime:restarting", () => {
      set({ builtinStatus: "restarting", builtinError: null });
    });
    await listen("runtime:failed", () => {
      set({
        builtinStatus: "error",
        builtinError: "Built-in runtime failed to start",
      });
      get().pushToast({
        kind: "error",
        text: "Built-in runtime failed to start",
      });
    });
    await listen<{ current: string; latest: string }>(
      "runtime:update-available",
      (e) => {
        get().pushToast({
          kind: "info",
          text: `A runtime update is available (${e.payload.current} → ${e.payload.latest}). Update to support the latest models and hardware.`,
        });
      },
    );
  },

  selectBuiltin: async () => {
    const port = get().builtinPort;
    if (port == null) {
      get().pushToast({ kind: "info", text: "Built-in runtime is still starting…" });
      return;
    }
    const baseUrl = builtinEndpoint(port);
    const cfg: RuntimeConfig = { baseUrl, apiKey: null };
    set({ active: cfg, healthy: get().builtinStatus === "ready" });
    await useProjectConfigStore.getState().setRuntimeBaseUrl(baseUrl);
    await useProjectConfigStore.getState().setRuntimeApiKey(null);
    if (get().builtinStatus === "ready") {
      await refreshModels(set, get, cfg);
    } else {
      // Can't confirm this runtime's models yet — don't carry over a model
      // from the previously-active runtime.
      set({ models: [], modelsError: null, selectedModelId: null });
    }
  },

  restartBuiltin: async () => {
    set({ builtinStatus: "restarting", builtinError: null });
    try {
      await restartRuntime();
    } catch (err) {
      set({
        builtinStatus: "error",
        builtinError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  selectDetected: async (runtime) => {
    const cfg: RuntimeConfig = { baseUrl: runtime.baseUrl, apiKey: null };
    set({ active: cfg, healthy: runtime.healthy });
    // Persist to the active project's config — immediate save, no batching.
    await useProjectConfigStore.getState().setRuntimeBaseUrl(runtime.baseUrl);
    await useProjectConfigStore.getState().setRuntimeApiKey(null);
    if (runtime.healthy) {
      await refreshModels(set, get, cfg);
    } else {
      // Offline runtime — clear the model so the chatbox doesn't show one from
      // the previously-active runtime.
      set({ models: [], modelsError: null, selectedModelId: null });
    }
  },

  saveManual: async (baseUrl, apiKey) => {
    const trimmed = baseUrl.trim().replace(/\/$/, "");
    if (!trimmed) return { ok: false, error: "Base URL required" };
    try {
      await listRuntimeModels(trimmed, apiKey);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const cfg: RuntimeConfig = { baseUrl: trimmed, apiKey: apiKey || null };
    set({ active: cfg, healthy: true });
    await useProjectConfigStore.getState().setRuntimeBaseUrl(trimmed);
    await useProjectConfigStore.getState().setRuntimeApiKey(apiKey || null);
    await refreshModels(set, get, cfg);
    return { ok: true };
  },

  selectModel: async (modelId) => {
    set({ selectedModelId: modelId });
    // Remember this as the model for the current runtime so switching away and
    // back restores it instead of dropping to "Select a model".
    const base = get().active?.baseUrl;
    if (base) {
      set({ lastModelByRuntime: { ...get().lastModelByRuntime, [base]: modelId } });
    }
    // Mirror to the active session's meta so swapping sessions restores the
    // model pill alongside the agent pill (per-session attachment).
    const { currentSessionId, setSessionMeta } = useMessagesStore.getState();
    if (currentSessionId) {
      setSessionMeta(currentSessionId, { modelId });
    }
    await useProjectConfigStore.getState().setRuntimeModel(modelId);
  },

  hydrateFromProject: async (cfg) => {
    try {
      if (!cfg) {
        // Project closed — drop selection but keep in-memory base URL so the
        // ConnectionPanel UI still has something to show.
        set({ selectedModelId: null });
        return;
      }
      const active: RuntimeConfig = {
        baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
        apiKey: cfg.apiKey,
      };
      // Only overwrite selectedModelId when the project config actually has
      // a model. Otherwise we'd briefly null out the user's just-picked
      // value while the disk write is in flight, which causes the picker to
      // flash "Select model" and downstream components (UsageMeter,
      // ChatBoxFooter) to thrash.
      const incomingModel = cfg.model || null;
      const currentModel = get().selectedModelId;
      set({
        active,
        selectedModelId: incomingModel ?? currentModel,
      });
      const healthy = await checkRuntimeHealth(
        active.baseUrl,
        active.apiKey ?? null,
      ).catch(() => false);
      set({ healthy });
      if (healthy) {
        await refreshModels(set, get, active);
      } else {
        set({ models: [], modelsError: null });
      }
    } catch (err) {
      // Hydration failures must never bubble up — they'd surface as an
      // unhandled rejection and (under React 18 + Tauri) can blank the
      // WebView. Log and continue with whatever state we have.
      // eslint-disable-next-line no-console
      console.warn("[runtime] hydrateFromProject failed:", err);
    }
  },

  pushToast: (toast) => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { ...toast, id }] });
    // Auto-dismiss timing + the slide-out animation are owned by the toast
    // component (RuntimeToasts), so it can animate the exit before removal.
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
