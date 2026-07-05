import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import {
  checkRuntimeHealth,
  detectRuntimes,
  getHardwareProfile,
  getSidecarStatus,
  listRuntimeModels,
  restartRuntime,
  startRuntime as startRuntimeCmd,
  stopRuntime as stopRuntimeCmd,
  type DetectedRuntime,
  type HardwareProfile,
  type SidecarStatusValue,
} from "../../lib/tauri/commands";
import { useProjectConfigStore } from "../../stores/use-project-config-store";
import { useMessagesStore } from "../../stores/use-messages-store";
import { usePrefsStore } from "../../stores/use-prefs-store";
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

/**
 * Where to send users to install each known runtime, keyed by the detected
 * `name` from the backend probe list. A runtime with no entry simply shows no
 * Install link. Paired with the `PROBES` list in `commands/llm.rs`.
 */
export const RUNTIME_INSTALL_URLS: Record<string, string> = {
  Ollama: "https://ollama.com/download",
  "LM Studio": "https://lmstudio.ai",
  "llama.cpp": "https://github.com/ggml-org/llama.cpp",
  MLX: "https://github.com/ml-explore/mlx-lm",
  Jan: "https://jan.ai",
};

/**
 * Sort priority for the detected-runtimes list: running first, then installed
 * but stopped, then not-installed (Install-link rows) at the bottom.
 */
export function runtimeSortRank(r: DetectedRuntime): number {
  if (r.healthy) return 0;
  if (r.installed) return 1;
  return 2;
}

export type RuntimeConfig = {
  baseUrl: string;
  apiKey: string | null;
};

/**
 * A runtime the user has added or used, persisted so it survives launches until
 * explicitly deleted (the "permanent runtimes" list). Covers custom endpoints
 * (OpenRouter, a remote vLLM, …) that local-port detection can never find, plus
 * detected runtimes the user has actually connected to. The ÄKÄ Built-in is
 * never stored here — it's always shown and can't be deleted.
 */
export type SavedRuntime = {
  baseUrl: string;
  apiKey: string | null;
  /** Display label — a custom endpoint's host, or a detected runtime's name. */
  name: string;
};

const RUNTIMES_STORE_FILE = "aka-runtimes.json";
const SAVED_RUNTIMES_KEY = "savedRuntimes";
const DISMISSED_RUNTIMES_KEY = "dismissedRuntimes";

/** Human label for a saved endpoint — the host, falling back to the raw URL. */
function labelForUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname || baseUrl;
  } catch {
    return baseUrl;
  }
}

/**
 * Align the egress gate with explicit user consent: typing a remote endpoint's
 * URL + key into AKA IS the informed-consent moment, so its host joins the
 * project's `network_allowlist` right then — instead of the first chat being
 * blocked with a "go edit Capabilities" detour. Deny-by-default is untouched
 * for every host the user did NOT add. Loopback needs no entry; no-op when no
 * project is open or the host is already covered.
 */
async function consentEgressForEndpoint(baseUrl: string): Promise<void> {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return;
  }
  if (!host || host === "localhost" || host === "::1" || host.startsWith("127.")) {
    return;
  }
  const cfgStore = useProjectConfigStore.getState();
  const entries = cfgStore.config?.capabilities.network_allowlist;
  // Entries may be bare hosts, host:port, or URL prefixes — a substring check
  // covers all three for dedup (worst case we skip adding a redundant entry).
  if (!entries || entries.some((e) => e.includes(host))) return;
  await cfgStore.setNetworkAllowlist([...entries, host]);
}

async function persistSavedRuntimes(list: SavedRuntime[]): Promise<void> {
  try {
    const store = await load(RUNTIMES_STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(SAVED_RUNTIMES_KEY, list);
    await store.save();
  } catch {
    // Outside Tauri (browser dev) — in-memory only.
  }
}

async function persistDismissedRuntimes(list: string[]): Promise<void> {
  try {
    const store = await load(RUNTIMES_STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(DISMISSED_RUNTIMES_KEY, list);
    await store.save();
  } catch {
    // Outside Tauri — in-memory only.
  }
}

/**
 * Upsert a runtime into the persisted saved list (keyed by base URL). Remembering
 * a runtime also clears it from the dismissed set — explicitly using a runtime
 * un-dismisses it, so a previously-deleted one the user reconnects to comes back.
 */
function rememberRuntime(
  set: (s: Partial<RuntimeState>) => void,
  get: () => RuntimeState,
  rt: SavedRuntime,
) {
  const next = [...get().savedRuntimes.filter((s) => s.baseUrl !== rt.baseUrl), rt];
  const prevDismissed = get().dismissedRuntimes;
  const dismissed = prevDismissed.filter((u) => u !== rt.baseUrl);
  set({ savedRuntimes: next, dismissedRuntimes: dismissed });
  void persistSavedRuntimes(next);
  if (dismissed.length !== prevDismissed.length) void persistDismissedRuntimes(dismissed);
}

/**
 * Fold installed detected runtimes into the saved list so the local runtimes the
 * user actually has (Ollama, MLX, …) appear under "Saved runtimes" without a
 * manual add — but never re-add one the user explicitly deleted (the dismissed
 * set). Not-installed/discoverable runtimes are left in the Detected section.
 * Persists only when something new is added, so the detection poll stays cheap.
 */
function syncDetectedIntoSaved(
  set: (s: Partial<RuntimeState>) => void,
  get: () => RuntimeState,
  detected: DetectedRuntime[],
) {
  const detectedByUrl = new Map(detected.map((d) => [d.baseUrl, d] as const));
  const dismissed = new Set(get().dismissedRuntimes);
  let changed = false;

  // Reconcile names: a saved entry that matches a detected runtime takes the
  // detected name ("Ollama"), not a hostname-derived label ("localhost") that a
  // config-hydrated entry may have been saved with. Detected names always win
  // for detected runtimes.
  let next = get().savedRuntimes.map((s) => {
    const d = detectedByUrl.get(s.baseUrl);
    if (d && d.name && d.name !== s.name) {
      changed = true;
      return { ...s, name: d.name };
    }
    return s;
  });

  // Fold in installed detected runtimes not yet saved (and not dismissed).
  const savedUrls = new Set(next.map((s) => s.baseUrl));
  const toAdd: SavedRuntime[] = detected
    .filter((d) => d.installed && !savedUrls.has(d.baseUrl) && !dismissed.has(d.baseUrl))
    .map((d) => ({ baseUrl: d.baseUrl, apiKey: null, name: d.name }));
  if (toAdd.length > 0) {
    next = [...next, ...toAdd];
    changed = true;
  }

  if (!changed) return;
  set({ savedRuntimes: next });
  void persistSavedRuntimes(next);
}

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
  /** Persisted runtimes the user added/used — shown until explicitly deleted. */
  savedRuntimes: SavedRuntime[];
  /** Base URLs the user deleted from the saved list — never auto-re-added. */
  dismissedRuntimes: string[];
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
  /** Boot a runtime AKA can launch (the Play button). */
  startRuntime: (name: string) => Promise<void>;
  /** Stop a runtime AKA started (the Stop button). */
  stopRuntime: (name: string) => Promise<void>;
  saveManual: (baseUrl: string, apiKey: string | null) => Promise<{ ok: boolean; error?: string }>;
  /** Remove a runtime from the persisted saved list. The built-in isn't in it. */
  deleteSavedRuntime: (baseUrl: string) => Promise<void>;
  /**
   * Edit a saved runtime's endpoint/key in place. Re-validates the new endpoint;
   * if the edited one is currently active, re-applies it so the change takes
   * effect immediately. Returns the same `{ ok, error }` shape as `saveManual`.
   */
  editSavedRuntime: (
    oldBaseUrl: string,
    baseUrl: string,
    apiKey: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
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
  savedRuntimes: [],
  dismissedRuntimes: [],
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

    // Restore the persisted runtimes (custom endpoints + previously-used
    // detected ones) so they're available across launches until deleted.
    try {
      const store = await load(RUNTIMES_STORE_FILE, { defaults: {}, autoSave: false });
      const saved = await store.get<SavedRuntime[]>(SAVED_RUNTIMES_KEY);
      const dismissed = await store.get<string[]>(DISMISSED_RUNTIMES_KEY);
      set({
        ...(Array.isArray(saved) ? { savedRuntimes: saved } : {}),
        ...(Array.isArray(dismissed) ? { dismissedRuntimes: dismissed } : {}),
      });
    } catch {
      // Outside Tauri — none.
    }

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
      // Fold installed local runtimes into the saved list so the ones the user
      // actually has show under "Saved runtimes" (respecting prior deletions).
      syncDetectedIntoSaved(set, get, detected);
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
    // Network egress guard (gate_egress): a denied outbound endpoint used to be
    // emitted here with no listener — a silent failure. Surface it as a visible
    // toast so a blocked BYOK/cloud endpoint is never silently swallowed.
    await listen<{ url: string; host: string; allowed: boolean }>(
      "network://egress",
      (e) => {
        if (e.payload.allowed) return;
        get().pushToast({
          kind: "error",
          text: `Network egress blocked: ${e.payload.host || e.payload.url} isn't in this project's allowlist. Add it under Capabilities to permit it.`,
        });
      },
    );
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
    // Connecting to a detected runtime makes it "used" — remember it so it stays
    // in the permanent list even if a later probe doesn't surface it.
    rememberRuntime(set, get, {
      baseUrl: runtime.baseUrl,
      apiKey: null,
      name: runtime.name,
    });
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

  startRuntime: async (name) => {
    try {
      await startRuntimeCmd(name);
    } catch (err) {
      get().pushToast({
        kind: "error",
        text: `Couldn't start ${name}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    get().pushToast({ kind: "info", text: `Starting ${name}…` });
    // Pick up managed=true right away; the dot flips green on a later poll once
    // the server's port answers.
    await get().refreshDetection({ silent: true });
  },

  stopRuntime: async (name) => {
    try {
      await stopRuntimeCmd(name);
    } catch (err) {
      get().pushToast({
        kind: "error",
        text: `Couldn't stop ${name}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    get().pushToast({ kind: "info", text: `Stopped ${name}` });
    await get().refreshDetection({ silent: true });
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
    // A validated custom endpoint joins the permanent list (local detection can
    // never find a remote endpoint like OpenRouter, so this is the only way it
    // persists).
    rememberRuntime(set, get, {
      baseUrl: trimmed,
      apiKey: apiKey || null,
      name: labelForUrl(trimmed),
    });
    await useProjectConfigStore.getState().setRuntimeBaseUrl(trimmed);
    await useProjectConfigStore.getState().setRuntimeApiKey(apiKey || null);
    // Adding the endpoint is the consent moment — open the egress gate for
    // exactly this host so the first chat isn't blocked with a settings detour.
    await consentEgressForEndpoint(trimmed);
    await refreshModels(set, get, cfg);
    return { ok: true };
  },

  deleteSavedRuntime: async (baseUrl) => {
    // Everything in savedRuntimes is user-removable; the built-in is never here.
    // Record the deletion so the detection poll doesn't auto-re-add a detected
    // local runtime the user removed on purpose.
    const next = get().savedRuntimes.filter((s) => s.baseUrl !== baseUrl);
    const dismissed = get().dismissedRuntimes.includes(baseUrl)
      ? get().dismissedRuntimes
      : [...get().dismissedRuntimes, baseUrl];
    set({ savedRuntimes: next, dismissedRuntimes: dismissed });
    await persistSavedRuntimes(next);
    await persistDismissedRuntimes(dismissed);
  },

  editSavedRuntime: async (oldBaseUrl, baseUrl, apiKey) => {
    const trimmed = baseUrl.trim().replace(/\/$/, "");
    if (!trimmed) return { ok: false, error: "Base URL required" };
    try {
      await listRuntimeModels(trimmed, apiKey);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const next = get().savedRuntimes.map((s) =>
      s.baseUrl === oldBaseUrl
        ? { baseUrl: trimmed, apiKey: apiKey || null, name: labelForUrl(trimmed) }
        : s,
    );
    set({ savedRuntimes: next });
    await persistSavedRuntimes(next);
    // Editing an endpoint is as much a consent act as adding one.
    await consentEgressForEndpoint(trimmed);
    // If we just edited the active runtime, re-apply it so the new URL/key take
    // effect right away (and the project config stays in sync).
    if (get().active?.baseUrl === oldBaseUrl) {
      const cfg: RuntimeConfig = { baseUrl: trimmed, apiKey: apiKey || null };
      set({ active: cfg, healthy: true });
      await useProjectConfigStore.getState().setRuntimeBaseUrl(trimmed);
      await useProjectConfigStore.getState().setRuntimeApiKey(apiKey || null);
      await refreshModels(set, get, cfg);
    }
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
      // Opt-in (`autoApplyPosture`, default off): drop any explicit posture
      // override so the session follows the NEW model's recommended posture.
      // Off → keep the user's choice; nothing auto-changes (Task 2 acceptance).
      const patch = usePrefsStore.getState().autoApplyPosture
        ? { modelId, posture: undefined }
        : { modelId };
      setSessionMeta(currentSessionId, patch);
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
      // Seed the permanent list from the project's configured runtime so a
      // custom endpoint (e.g. OpenRouter) surfaces under "Saved runtimes" even
      // though local detection can't find it — and even if it was configured
      // before this list existed. The built-in is never saved (always shown,
      // undeletable); detected local runtimes are de-duped at render time.
      const builtinPort = get().builtinPort;
      const builtinUrl = builtinPort != null ? builtinEndpoint(builtinPort) : null;
      if (active.baseUrl && active.baseUrl !== builtinUrl) {
        rememberRuntime(set, get, {
          baseUrl: active.baseUrl,
          apiKey: active.apiKey ?? null,
          name: labelForUrl(active.baseUrl),
        });
        // The project's own config carries this endpoint — consent the user
        // already gave when they entered it. Honor it at the egress gate so a
        // pre-existing remote runtime (e.g. OpenRouter from an older version)
        // doesn't hit a "blocked" toast on its first chat after upgrading.
        await consentEgressForEndpoint(active.baseUrl);
      }
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
