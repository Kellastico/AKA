import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  hfListGgufFiles,
  hfSearchModels,
  importModel,
  listLocalModels,
  loadBuiltinModel,
  pickGgufFile,
  unloadBuiltinModel,
  type DownloadComplete,
  type DownloadError,
  type DownloadProgress,
  type HfGgufFile,
  type HfModel,
  type HfSort,
  type LocalModel,
} from "../../lib/tauri/commands";
import {
  modelIdFromFilename,
  type CuratedModel,
} from "./curated-models";
import { useRuntimeStore } from "./use-runtime-store";
import { useProjectConfigStore } from "../../stores/use-project-config-store";

const hasTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * Manage Models only ever lists models you actually have, so "installed" and
 * the tier buckets no longer separate anything. What is worth filtering on is
 * whether this machine can run the thing.
 */
export type ModelFilter = "all" | "fits";

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

  // --- HuggingFace discovery (search + paste-a-repo) ---
  hfPanelOpen: boolean;
  hfQuery: string;
  /** The query the current results belong to — echoed as "Searched for …". */
  hfSubmittedQuery: string;
  hfSearching: boolean;
  hfResults: HfModel[];
  /** True once a search/lookup has run, to distinguish "no results" from idle. */
  hfSearched: boolean;
  hfError: string | null;
  /** The repo whose files are being shown, or null while at the search list. */
  hfSelectedRepo: string | null;
  /**
   * Per-repo `.gguf` listings, keyed by `owner/name`. Result rows fill this in
   * as they scroll into view — a row needs the real byte size of the quant it
   * stands for, and the search response carries no sizes. Drilling into a repo
   * then reads the same entry, so the file list is usually already there.
   */
  hfRepoFiles: Record<string, HfGgufFile[]>;
  /** Repos with a listing request in flight, so one row fetches each repo once. */
  hfLoadingRepos: Record<string, boolean>;

  /** Server-side ordering — changing it re-runs the search. */
  hfSort: HfSort;
  /** Owners kept by the "Created By" facet. Empty = no author filter. */
  hfAuthors: string[];
  /** Quant labels kept by the "Quantizations" facet. Empty = no quant filter. */
  hfQuants: string[];
  /** Whether the facet sidebar is showing. */
  hfFiltersOpen: boolean;

  openHfPanel: () => void;
  closeHfPanel: () => void;
  setHfQuery: (q: string) => void;
  /** Run the input: a repo id/URL jumps straight to its files; else search. */
  submitHfInput: () => Promise<void>;
  /**
   * Search `q` and install the results. `keepFacets` preserves the author /
   * quant picks (pruned to the new result set) — true when re-sorting the same
   * query, false for a query the user just typed.
   */
  runHfSearch: (q: string, keepFacets: boolean) => Promise<void>;
  selectHfRepo: (repo: string) => Promise<void>;
  /** Fetch a repo's `.gguf` listing unless it is cached or already in flight. */
  ensureHfRepoFiles: (repo: string) => Promise<void>;
  /** Step back one level: a repo's files → results → the empty prompt → closed. */
  hfBack: () => void;
  /** Download a chosen repo file, routed through the existing RAM gate. */
  downloadHfFile: (repo: string, file: HfGgufFile) => void;

  setHfSort: (sort: HfSort) => void;
  toggleHfAuthor: (author: string) => void;
  toggleHfQuant: (quant: string) => void;
  clearHfFacets: () => void;
  toggleHfFilters: () => void;
};

let listenersInstalled = false;

/** Heuristic: does the input look like a repo id / HF URL rather than a search? */
function looksLikeRepo(input: string): boolean {
  const q = input.trim();
  if (q.includes("huggingface.co/")) return true;
  // `owner/name`: exactly one slash, no spaces, both segments non-empty.
  return /^[\w.-]+\/[\w.-]+$/.test(q);
}

/** Strip a pasted HF URL down to `owner/name` for display/lookup. */
function repoIdFromInput(input: string): string {
  let s = input.trim();
  const marker = "huggingface.co/";
  const at = s.indexOf(marker);
  if (at >= 0) s = s.slice(at + marker.length);
  const [owner, name] = s.replace(/^\/+|\/+$/g, "").split("/");
  return owner && name ? `${owner}/${name}` : s;
}

/** Rough RAM floor for a GGUF: its size plus working overhead. Drives the RAM
 *  gate for community models, where no curated `minRamGb` exists. */
function estimateMinRamGb(sizeGb: number): number {
  if (sizeGb <= 0) return 0;
  return Math.ceil(sizeGb + 1.5);
}

export const useModelBrowserStore = create<ModelBrowserState>((set, get) => ({
  open: false,
  initialized: false,
  localModels: [],
  downloads: {},
  filter: "all",
  ramGateModel: null,
  loadingModel: null,

  hfPanelOpen: false,
  hfQuery: "",
  hfSubmittedQuery: "",
  hfSearching: false,
  hfResults: [],
  hfSearched: false,
  hfError: null,
  hfSelectedRepo: null,
  hfRepoFiles: {},
  hfLoadingRepos: {},
  hfSort: "downloads",
  hfAuthors: [],
  hfQuants: [],
  hfFiltersOpen: true,

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
      const outcome = await loadBuiltinModel(filename);
      // A switch can shrink the context window: what a window costs depends on
      // the model, so one that was safe before can exceed this machine's RAM
      // now. Say so — silently changing it under the user is how a switch
      // turns into a crash they can't explain.
      if (outcome?.ctxClamped) {
        useRuntimeStore.getState().pushToast({
          kind: "info",
          text:
            `Context reduced to ${outcome.ctxSize.toLocaleString()} tokens — ` +
            `${outcome.ctxRequested.toLocaleString()} would not fit this model in RAM.`,
        });
      }
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

  openHfPanel: () =>
    set({
      hfPanelOpen: true,
      hfError: null,
    }),

  closeHfPanel: () =>
    set({
      hfPanelOpen: false,
      hfQuery: "",
      hfSubmittedQuery: "",
      hfResults: [],
      hfSearched: false,
      hfError: null,
      hfSelectedRepo: null,
      hfAuthors: [],
      hfQuants: [],
    }),

  setHfQuery: (hfQuery) => set({ hfQuery }),

  submitHfInput: async () => {
    const q = get().hfQuery.trim();
    if (!q) return;
    // A pasted repo id / URL skips search and goes straight to its files.
    if (looksLikeRepo(q)) {
      await get().selectHfRepo(repoIdFromInput(q));
      return;
    }
    // A query the user typed is a new question — facet picks were made against
    // a different result set, so they go.
    await get().runHfSearch(q, false);
  },

  runHfSearch: async (q, keepFacets) => {
    set({
      hfSearching: true,
      hfError: null,
      hfSelectedRepo: null,
      ...(keepFacets ? {} : { hfAuthors: [], hfQuants: [] }),
    });
    try {
      const hfResults = await hfSearchModels(q, get().hfSort);
      set({ hfResults, hfSearched: true, hfSubmittedQuery: q });
      // A reorder can slide repos in and out of the 50-hit window, so drop any
      // kept pick the new set no longer offers — otherwise the list filters
      // down to nothing with no visible reason why.
      if (keepFacets) {
        const authors = new Set(hfResults.map((r) => r.author));
        const quants = new Set(hfResults.flatMap((r) => r.quants));
        set({
          hfAuthors: get().hfAuthors.filter((a) => authors.has(a)),
          hfQuants: get().hfQuants.filter((qt) => quants.has(qt)),
        });
      }
    } catch (err) {
      set({
        hfResults: [],
        hfSearched: true,
        hfSubmittedQuery: q,
        hfError: err instanceof Error ? err.message : "Search failed",
      });
    } finally {
      set({ hfSearching: false });
    }
  },

  selectHfRepo: async (repo) => {
    set({ hfSelectedRepo: repo, hfError: null });
    await get().ensureHfRepoFiles(repo);
  },

  ensureHfRepoFiles: async (repo) => {
    const s = get();
    // Rows and the file list both ask for this; whoever gets there first wins
    // and the rest read the cache.
    if (s.hfRepoFiles[repo] || s.hfLoadingRepos[repo]) return;
    set({ hfLoadingRepos: { ...get().hfLoadingRepos, [repo]: true } });
    try {
      const files = await hfListGgufFiles(repo);
      set({ hfRepoFiles: { ...get().hfRepoFiles, [repo]: files } });
    } catch (err) {
      // Only surface the failure when the user is looking at that repo — a
      // background row fetch shouldn't put a banner over the result list.
      if (get().hfSelectedRepo === repo) {
        set({
          hfError:
            err instanceof Error
              ? err.message
              : "Could not list repository files",
        });
      }
      set({ hfRepoFiles: { ...get().hfRepoFiles, [repo]: [] } });
    } finally {
      const { [repo]: _done, ...rest } = get().hfLoadingRepos;
      set({ hfLoadingRepos: rest });
    }
  },

  hfBack: () => {
    // One predictable step out at a time, so Back never skips a level.
    const s = get();
    if (s.hfSelectedRepo) {
      set({ hfSelectedRepo: null, hfError: null });
      return;
    }
    if (s.hfSearched || s.hfResults.length > 0) {
      set({
        hfQuery: "",
        hfSubmittedQuery: "",
        hfResults: [],
        hfSearched: false,
        hfError: null,
        hfAuthors: [],
        hfQuants: [],
      });
      return;
    }
    get().closeHfPanel();
  },

  setHfSort: (hfSort) => {
    if (get().hfSort === hfSort) return;
    set({ hfSort });
    // Ordering is a HuggingFace query parameter, so it needs a fresh request.
    // Re-run the query the results belong to, not whatever is in the box — the
    // user may have started typing their next search already.
    const submitted = get().hfSubmittedQuery;
    if (submitted) void get().runHfSearch(submitted, true);
  },

  toggleHfAuthor: (author) =>
    set(({ hfAuthors }) => ({
      hfAuthors: hfAuthors.includes(author)
        ? hfAuthors.filter((a) => a !== author)
        : [...hfAuthors, author],
    })),

  toggleHfQuant: (quant) =>
    set(({ hfQuants }) => ({
      hfQuants: hfQuants.includes(quant)
        ? hfQuants.filter((q) => q !== quant)
        : [...hfQuants, quant],
    })),

  clearHfFacets: () => set({ hfAuthors: [], hfQuants: [] }),

  toggleHfFilters: () =>
    set(({ hfFiltersOpen }) => ({ hfFiltersOpen: !hfFiltersOpen })),

  downloadHfFile: (repo, file) => {
    if (file.sharded) return; // multi-part models can't be loaded standalone
    const sizeGb = file.sizeBytes / 1_073_741_824;
    // Build a synthetic catalog entry so community downloads reuse the exact
    // same RAM gate, progress seeding, and completion handling as curated ones.
    const model: CuratedModel = {
      id: `hf-${repo}-${file.filename}`,
      name: modelIdFromFilename(file.filename),
      description: `From ${repo}`,
      huggingfaceRepo: repo,
      filename: file.filename,
      sizeGb,
      minRamGb: estimateMinRamGb(sizeGb),
      tier: "standard",
      tags: ["huggingface"],
      contextWindow: 0,
      verified: false,
    };
    get().requestDownload(model);
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

/** Descriptor for a model that lives on disk (or is on its way there). */
function localDescriptor(filename: string, sizeBytes: number): CuratedModel {
  const sizeGb = sizeBytes / 1_073_741_824;
  return {
    id: `local-${filename}`,
    name: modelIdFromFilename(filename),
    description: "",
    huggingfaceRepo: "",
    filename,
    sizeGb,
    // Nothing on disk tells us what a model needs, so estimate it from the
    // weights. The UI labels this as an estimate rather than a spec.
    minRamGb: estimateMinRamGb(sizeGb),
    tier: "standard",
    tags: [],
    contextWindow: 0,
    verified: false,
  };
}

/**
 * The Manage Models list: models on disk, plus any download still in flight.
 *
 * In-flight downloads are included deliberately. They aren't on disk yet, but
 * dropping them would mean starting a download from the HuggingFace panel,
 * closing it, and finding no progress bar and no way to cancel anywhere.
 */
export function installedBrowserModels(
  local: LocalModel[],
  downloads: Record<string, DownloadState>,
): CuratedModel[] {
  const onDisk = local.map((m) => localDescriptor(m.filename, m.sizeBytes));
  const have = new Set(local.map((m) => m.filename));
  const arriving = Object.entries(downloads)
    .filter(([filename]) => !have.has(filename))
    .map(([filename, d]) => localDescriptor(filename, d.totalBytes));
  return [...onDisk, ...arriving].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

/** Whether this machine has the RAM to run `model`. Unknown RAM counts as fine. */
export function fitsHardware(model: CuratedModel, totalRamGb: number): boolean {
  if (!totalRamGb || totalRamGb <= 0) return true;
  if (model.minRamGb <= 0) return true;
  return model.minRamGb <= totalRamGb;
}
