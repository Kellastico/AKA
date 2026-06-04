import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  importModel,
  listLocalModels,
  loadBuiltinModel,
  pickGgufFile,
  unloadBuiltinModel,
  type DownloadComplete,
  type DownloadError,
  type DownloadProgress,
  type LocalModel,
} from "../../lib/tauri/commands";
import {
  CURATED_MODELS,
  modelIdFromFilename,
  type CuratedModel,
} from "./curated-models";
import { useRuntimeStore } from "./use-runtime-store";
import { useProjectConfigStore } from "../../stores/use-project-config-store";

const hasTauri = () => "__TAURI_INTERNALS__" in window;

export type ModelFilter = "all" | "installed" | "light" | "standard" | "pro";

/** Live download progress with a derived transfer rate for ETA. */
export type DownloadState = {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  startedAt: number;
  bytesPerSec: number;
};

type ModelBrowserState = {
  open: boolean;
  initialized: boolean;
  localModels: LocalModel[];
  downloads: Record<string, DownloadState>;
  filter: ModelFilter;
  /** A model whose RAM requirement exceeds this machine — awaiting confirm. */
  ramGateModel: CuratedModel | null;
  /** Filename currently being loaded into the built-in runtime, or null. */
  loadingModel: string | null;

  init: () => Promise<void>;
  openBrowser: () => void;
  closeBrowser: () => void;
  refreshLocal: () => Promise<void>;
  setFilter: (f: ModelFilter) => void;

  /** Begin a download, routing through the RAM gate if needed. */
  requestDownload: (model: CuratedModel) => void;
  /** Proceed with a download past the RAM gate (or directly). */
  confirmDownload: (model: CuratedModel) => Promise<void>;
  dismissRamGate: () => void;
  showWhatFits: () => void;

  cancel: (filename: string) => Promise<void>;
  remove: (filename: string) => Promise<void>;
  importFromFile: () => Promise<void>;

  /** Load a downloaded model into the built-in runtime and select it. */
  loadModel: (filename: string) => Promise<void>;
  /** Unload the built-in runtime's model and clear the selection. */
  unloadModel: () => Promise<void>;

  isInstalled: (filename: string) => boolean;
  isActive: (filename: string) => boolean;
};

let listenersInstalled = false;

export const useModelBrowserStore = create<ModelBrowserState>((set, get) => ({
  open: false,
  initialized: false,
  localModels: [],
  downloads: {},
  filter: "all",
  ramGateModel: null,
  loadingModel: null,

  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    await get().refreshLocal();

    if (!hasTauri() || listenersInstalled) return;
    listenersInstalled = true;

    await listen<DownloadProgress>("model:download-progress", (e) => {
      const p = e.payload;
      const prev = get().downloads[p.filename];
      const startedAt = prev?.startedAt ?? Date.now();
      const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001);
      const bytesPerSec = p.bytesDownloaded / elapsedSec;
      set({
        downloads: {
          ...get().downloads,
          [p.filename]: {
            bytesDownloaded: p.bytesDownloaded,
            totalBytes: p.totalBytes,
            percent: p.percent,
            startedAt,
            bytesPerSec,
          },
        },
      });
    });

    await listen<DownloadComplete>("model:download-complete", (e) => {
      const { [e.payload.filename]: _done, ...rest } = get().downloads;
      set({ downloads: rest });
      void get().refreshLocal();
      // Confirmation for models added to the built-in runtime (the only place
      // models are "added" — external runtimes are discovered, not added here).
      useRuntimeStore.getState().pushToast({
        kind: "success",
        text: `Added ${modelIdFromFilename(e.payload.filename)} to the built-in runtime`,
      });
    });

    await listen<DownloadError>("model:download-error", (e) => {
      const { [e.payload.filename]: _err, ...rest } = get().downloads;
      set({ downloads: rest });
      if (e.payload.error !== "cancelled") {
        useRuntimeStore.getState().pushToast({
          kind: "error",
          text: `Download failed: ${e.payload.filename}`,
        });
      }
    });
  },

  openBrowser: () => {
    set({ open: true });
    void get().init();
    void get().refreshLocal();
  },
  closeBrowser: () => set({ open: false }),

  refreshLocal: async () => {
    try {
      set({ localModels: await listLocalModels() });
    } catch {
      /* leave existing list */
    }
  },

  setFilter: (filter) => set({ filter }),

  requestDownload: (model) => {
    const hw = useRuntimeStore.getState().hardware;
    // RAM gate: only block when we actually know the machine's RAM.
    if (hw && hw.totalRamGb > 0 && model.minRamGb > hw.totalRamGb) {
      set({ ramGateModel: model });
      return;
    }
    void get().confirmDownload(model);
  },

  confirmDownload: async (model) => {
    set({ ramGateModel: null });
    // Seed an immediate 0% entry so the card flips to "downloading" at once.
    set({
      downloads: {
        ...get().downloads,
        [model.filename]: {
          bytesDownloaded: 0,
          totalBytes: Math.round(model.sizeGb * 1_073_741_824),
          percent: 0,
          startedAt: Date.now(),
          bytesPerSec: 0,
        },
      },
    });
    try {
      await downloadModel(model.huggingfaceRepo, model.filename);
    } catch {
      // Error toast handled by the model:download-error listener.
      const { [model.filename]: _e, ...rest } = get().downloads;
      set({ downloads: rest });
    }
  },

  dismissRamGate: () => set({ ramGateModel: null }),

  showWhatFits: () => {
    const hw = useRuntimeStore.getState().hardware;
    const tier = hw?.recommendedTier ?? "all";
    set({
      ramGateModel: null,
      filter: tier === "all" ? "all" : (tier as ModelFilter),
    });
  },

  cancel: async (filename) => {
    await cancelDownload(filename);
    const { [filename]: _c, ...rest } = get().downloads;
    set({ downloads: rest });
  },

  remove: async (filename) => {
    await deleteModel(filename);
    await get().refreshLocal();
    // If the removed model was active, clear the selection.
    if (get().isActive(filename)) await get().unloadModel();
  },

  importFromFile: async () => {
    const path = await pickGgufFile();
    if (!path) return;
    try {
      const filename = await importModel(path);
      await get().refreshLocal();
      useRuntimeStore.getState().pushToast({
        kind: "success",
        text: `Added ${modelIdFromFilename(filename)} to the built-in runtime`,
      });
    } catch (err) {
      useRuntimeStore.getState().pushToast({
        kind: "error",
        text: err instanceof Error ? err.message : "Import failed",
      });
    }
  },

  loadModel: async (filename) => {
    // Preload the weights into the sidecar (shows a spinner; surfaces load
    // errors up front) before making it the active runtime/model. Chat would
    // also lazy-load, but the explicit path gives immediate feedback for the
    // multi-second load of a large model.
    if (get().loadingModel) return; // one load at a time
    set({ loadingModel: filename });
    try {
      await loadBuiltinModel(filename);
      await useRuntimeStore.getState().selectBuiltin();
      await useRuntimeStore.getState().selectModel(modelIdFromFilename(filename));
      useRuntimeStore.getState().pushToast({
        kind: "success",
        text: `${modelIdFromFilename(filename)} is ready`,
      });
    } catch (err) {
      useRuntimeStore.getState().pushToast({
        kind: "error",
        text: err instanceof Error ? err.message : "Failed to load model",
      });
    } finally {
      set({ loadingModel: null });
    }
  },

  unloadModel: async () => {
    // Free the weights in the sidecar, then clear the selection.
    await unloadBuiltinModel().catch(() => {});
    useRuntimeStore.setState({ selectedModelId: null });
    await useProjectConfigStore.getState().setRuntimeModel("");
  },

  isInstalled: (filename) =>
    get().localModels.some((m) => m.filename === filename),

  isActive: (filename) => {
    const rt = useRuntimeStore.getState();
    const builtinActive =
      rt.builtinPort != null &&
      rt.active?.baseUrl === `http://127.0.0.1:${rt.builtinPort}/v1`;
    return builtinActive && rt.selectedModelId === modelIdFromFilename(filename);
  },
}));

/** Curated entries plus any local models not in the curated list (unverified). */
export function allBrowserModels(local: LocalModel[]): CuratedModel[] {
  const curated = [...CURATED_MODELS];
  const curatedFilenames = new Set(curated.map((m) => m.filename));
  const extras: CuratedModel[] = local
    .filter((m) => !curatedFilenames.has(m.filename))
    .map((m) => ({
      id: `local-${m.filename}`,
      name: m.filename.replace(/\.gguf$/i, ""),
      description: "Imported local model.",
      huggingfaceRepo: "",
      filename: m.filename,
      sizeGb: m.sizeBytes / 1_073_741_824,
      minRamGb: 0,
      tier: "standard",
      tags: ["local"],
      contextWindow: 0,
      verified: false,
    }));
  return [...curated, ...extras];
}
