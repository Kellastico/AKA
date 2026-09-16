import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Cpu,
  Cube,
  DownloadSimple,
  FadersHorizontal,
  FilePlus,
  FolderOpen,
  Funnel,
  Heart,
  MagnifyingGlass,
  ShieldCheck,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Collapse } from "../../components/Collapse";
import {
  formatParameters,
  pipelineLabel,
  prettyQuant,
  representativeQuant,
} from "./hf-display";
import huggingfaceLogo from "../../assets/huggingface-logo.png";
import {
  fitsHardware,
  installedBrowserModels,
  useModelBrowserStore,
  type ModelFilter,
} from "./use-model-browser-store";
import { type CuratedModel } from "./curated-models";
import { useRuntimeStore } from "./use-runtime-store";
import {
  modelsDirPath,
  openModelsFolder,
  type HfGgufFile,
  type HfModel,
  type HfSort,
} from "../../lib/tauri/commands";

/** Mirrors `HF_SEARCH_LIMIT` in the Rust command — a full page means there are
 *  more hits than were fetched, so the count is shown as "50+". */
const HF_RESULT_LIMIT = 50;

const FILTERS: { id: ModelFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "fits", label: "Fits this device" },
];

function formatGb(gb: number): string {
  if (gb <= 0) return "—";
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
}

function formatBytes(bytes: number): string {
  return formatGb(bytes / 1_073_741_824);
}

/** Compact count, e.g. 12345 → "12.3k". */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (bytesPerSec <= 0 || remainingBytes <= 0) return "—";
  const secs = Math.round(remainingBytes / bytesPerSec);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function gpuLabel(gpu: string | undefined): string {
  switch (gpu) {
    case "apple-silicon":
      return "Apple Silicon";
    case "nvidia-cuda":
      return "NVIDIA CUDA";
    case "cpu-only":
      return "CPU";
    default:
      return "Unknown";
  }
}

export function ModelBrowser() {
  const open = useModelBrowserStore((s) => s.open);
  const close = useModelBrowserStore((s) => s.closeBrowser);
  const filter = useModelBrowserStore((s) => s.filter);
  const setFilter = useModelBrowserStore((s) => s.setFilter);
  const localModels = useModelBrowserStore((s) => s.localModels);
  const downloads = useModelBrowserStore((s) => s.downloads);
  const importFromFile = useModelBrowserStore((s) => s.importFromFile);
  const ramGateModel = useModelBrowserStore((s) => s.ramGateModel);
  const openHfPanel = useModelBrowserStore((s) => s.openHfPanel);
  const hfPanelOpen = useModelBrowserStore((s) => s.hfPanelOpen);
  const hardware = useRuntimeStore((s) => s.hardware);

  // The on-disk models folder, shown so users know where downloads live and can
  // jump straight to it. Loaded when the browser opens (no-op in the browser).
  const [modelsPath, setModelsPath] = useState("");
  useEffect(() => {
    if (open) void modelsDirPath().then(setModelsPath).catch(() => {});
  }, [open]);

  if (!open) return null;

  const models = installedBrowserModels(localModels, downloads);
  const totalRamGb = hardware?.totalRamGb ?? 0;
  const visible =
    filter === "fits"
      ? models.filter((m) => fitsHardware(m, totalRamGb))
      : models;
  const totalGb = models.reduce((sum, m) => sum + m.sizeGb, 0);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-6"
      onClick={close}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#16131f] text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-base font-semibold">Models</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={openHfPanel}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-100 hover:bg-amber-400/20"
            >
              <MagnifyingGlass size={14} />
              Add Model (via Huggingface)
            </button>
            <button
              onClick={() => void importFromFile()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10"
            >
              <FilePlus size={14} />
              Add from file
            </button>
            <button
              onClick={close}
              className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* This machine, and where its models live. Both were previously
            afterthoughts — a one-line banner and an 11px grey path — so they
            share one panel now and the folder is legible and reachable. */}
        <div className="flex flex-col gap-2.5 border-b border-white/10 bg-white/5 px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-white/70">
            <Cpu size={14} className="shrink-0 text-white/45" />
            {hardware ? (
              <span>
                {gpuLabel(hardware.gpuType)} ·{" "}
                <span className="text-white/90">
                  {Math.round(hardware.totalRamGb)}GB RAM
                </span>
              </span>
            ) : (
              <span className="text-white/40">
                Hardware details unavailable in browser preview
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <FolderOpen size={16} weight="fill" className="shrink-0 text-amber-300/70" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-xs text-white/70">
                {models.length} model{models.length === 1 ? "" : "s"}
                {totalGb > 0 ? ` · ${formatGb(totalGb)} on disk` : ""}
              </span>
              <span
                className="truncate font-mono text-[11px] text-white/45"
                title={modelsPath || undefined}
              >
                {modelsPath || "…"}
              </span>
            </div>
            <button
              onClick={() => void openModelsFolder()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10 hover:text-white"
            >
              <ArrowSquareOut size={13} />
              Reveal
            </button>
          </div>
        </div>

        {/* Filter pills */}
        <div className="flex gap-1.5 px-5 py-3">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={[
                "rounded-full px-3 py-1 text-xs transition",
                filter === f.id
                  ? "bg-amber-400/20 text-amber-200"
                  : "text-white/60 hover:bg-white/10 hover:text-white",
              ].join(" ")}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 gap-3 overflow-y-auto px-5 pb-5 sm:grid-cols-2">
          {visible.map((m) => (
            <ModelCard key={m.id} model={m} />
          ))}
          {visible.length === 0 ? (
            <div className="col-span-full flex flex-col items-center gap-1.5 py-10 text-center">
              <Cube size={26} className="text-white/20" />
              <div className="text-sm text-white/50">
                {models.length === 0
                  ? "No models yet"
                  : "Nothing this device can run"}
              </div>
              <div className="max-w-sm text-xs text-white/30">
                {models.length === 0
                  ? "Add one via HuggingFace, or from a file on disk. Downloaded models show up here."
                  : `Every model you have needs more than ${Math.round(totalRamGb)}GB of RAM. Switch to All to see them.`}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {ramGateModel ? <RamGateDialog model={ramGateModel} /> : null}
      {hfPanelOpen ? <HfPanel /> : null}
    </div>
  );
}

/**
 * One model you actually have. Everything here is read off the file on disk —
 * there is no catalog behind it any more — so the RAM figure is an estimate and
 * is labelled as one.
 */
function ModelCard({ model }: { model: CuratedModel }) {
  const download = useModelBrowserStore((s) => s.downloads[model.filename]);
  const isInstalled = useModelBrowserStore((s) => s.isInstalled(model.filename));
  const isActive = useModelBrowserStore((s) => s.isActive(model.filename));
  const cancel = useModelBrowserStore((s) => s.cancel);
  const remove = useModelBrowserStore((s) => s.remove);
  const loadModel = useModelBrowserStore((s) => s.loadModel);
  const unloadModel = useModelBrowserStore((s) => s.unloadModel);
  const isLoading = useModelBrowserStore((s) => s.loadingModel === model.filename);
  const hardware = useRuntimeStore((s) => s.hardware);

  const totalRamGb = hardware?.totalRamGb ?? 0;
  const ramKnown = totalRamGb > 0 && model.minRamGb > 0;
  const fits = fitsHardware(model, totalRamGb);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Cube size={15} weight="fill" className="shrink-0 text-amber-300/80" />
          <span className="truncate text-sm font-medium" title={model.name}>
            {model.name}
          </span>
        </div>
        {isActive ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-emerald-300/80">
            <CheckCircle size={12} weight="fill" /> Loaded
          </span>
        ) : null}
      </div>

      {/* Size, what it needs, and whether this machine has it. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]">
        <span className="text-white/55">{formatGb(model.sizeGb)}</span>
        {model.minRamGb > 0 ? (
          <span className="text-white/40" title="Estimated from the file size">
            ~{model.minRamGb}GB RAM est.
          </span>
        ) : null}
        {ramKnown ? (
          fits ? (
            <span className="inline-flex items-center gap-1 rounded bg-emerald-400/15 px-1.5 py-px text-[10px] text-emerald-200/90">
              <CheckCircle size={10} weight="fill" /> Fits this device
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-px text-[10px] text-amber-200/90"
              title={`Needs about ${model.minRamGb}GB — this machine has ${Math.round(totalRamGb)}GB`}
            >
              <Warning size={10} weight="fill" /> Over {Math.round(totalRamGb)}GB RAM
            </span>
          )
        ) : null}
      </div>

      {/* Where this specific file lives. All models share one folder, so the
          button reveals that folder rather than pretending to select the file. */}
      <button
        onClick={() => void openModelsFolder()}
        className="group flex min-w-0 items-center gap-1.5 rounded text-left text-[10px] text-white/30 hover:text-white/70"
        title="Show in the models folder"
      >
        <FolderOpen size={11} className="shrink-0" />
        <span className="truncate font-mono">{model.filename}</span>
        <ArrowSquareOut
          size={10}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        />
      </button>

      {/* State-aware action row */}
      <div className="mt-1 flex items-center gap-2">
        {download ? (
          <DownloadRow filename={model.filename} onCancel={() => void cancel(model.filename)} />
        ) : isActive ? (
          <button
            onClick={() => void unloadModel()}
            className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/20 hover:text-white"
          >
            Unload
          </button>
        ) : isInstalled ? (
          <button
            onClick={() => void loadModel(model.filename)}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-2.5 py-1.5 text-xs text-white hover:bg-white/25 disabled:cursor-wait disabled:opacity-60 disabled:hover:bg-white/15"
          >
            {isLoading ? (
              <>
                <CircleNotch size={13} className="animate-spin" />
                Loading…
              </>
            ) : (
              "Load Model"
            )}
          </button>
        ) : null}

        <div className="flex-1" />

        {isInstalled && !download ? (
          <button
            onClick={() => void remove(model.filename)}
            className="rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-red-300"
            title="Delete model"
          >
            <Trash size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DownloadRow({
  filename,
  onCancel,
}: {
  filename: string;
  onCancel: () => void;
}) {
  const d = useModelBrowserStore((s) => s.downloads[filename]);
  if (!d) return null;
  const remaining = Math.max(d.totalBytes - d.bytesDownloaded, 0);
  const mb = (d.bytesDownloaded / 1_048_576).toFixed(0);
  const totalMb = d.totalBytes > 0 ? (d.totalBytes / 1_048_576).toFixed(0) : "?";

  return (
    <div className="flex flex-1 items-center gap-2">
      <div className="flex flex-1 flex-col gap-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-amber-400 transition-all"
            style={{ width: `${Math.min(d.percent, 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-white/40">
          <span>
            {mb} / {totalMb} MB ({Math.round(d.percent)}%)
          </span>
          <span>{formatEta(remaining, d.bytesPerSec)} left</span>
        </div>
      </div>
      <button
        onClick={onCancel}
        className="rounded-lg px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HuggingFace picker
//
// A search-first browser over the GGUF side of the HuggingFace index. Rows are
// repos, not files: one search is one request, and the exact file sizes (which
// only the per-repo tree API knows) are deferred to the quant picker behind
// each row's Download button. Everything in a row — parameter count, task,
// context, available quants — rides along on that single search response.
// ---------------------------------------------------------------------------

/** How the sidebar's Sort By section maps onto HuggingFace's orderings. */
const HF_SORTS: { id: HfSort; label: string }[] = [
  { id: "downloads", label: "Most downloaded" },
  { id: "likes", label: "Most liked" },
  { id: "trendingScore", label: "Trending" },
  { id: "lastModified", label: "Recently updated" },
];

/** Up-to-two-letter initials for an owner: `lmstudio-community` → `LC`. */
function initialsOf(author: string): string {
  const parts = author.split(/[-_. ]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? author).slice(0, 2).toUpperCase();
}

/** Stable hue per owner, so the same org keeps the same tile colour. */
function hueOf(author: string): number {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) % 360;
  return h;
}

/**
 * Initials tile standing in for the org's avatar. AKA is offline-first, so
 * rows never reach out to HuggingFace's CDN for images — the tile is derived
 * entirely from the owner name and always renders.
 */
function AuthorAvatar({ author, size = 40 }: { author: string; size?: number }) {
  const hue = hueOf(author);
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        background: `hsl(${hue} 42% 26%)`,
        color: `hsl(${hue} 70% 78%)`,
        fontSize: size * 0.36,
      }}
      className="flex shrink-0 items-center justify-center rounded-lg font-semibold tracking-wide"
    >
      {initialsOf(author)}
    </div>
  );
}

/** One value in a facet, with how many of the current results carry it. */
type Facet = { value: string; count: number };

/**
 * Tally `values`, commonest first. Anything already `selected` is kept in the
 * list even at zero — otherwise a pick that the other facet narrows to nothing
 * would vanish from the sidebar with no way left to undo it.
 */
function facetCounts(values: string[], selected: string[]): Facet[] {
  const counts = new Map<string, number>();
  for (const v of selected) counts.set(v, 0);
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function HfPanel() {
  const close = useModelBrowserStore((s) => s.closeHfPanel);
  const query = useModelBrowserStore((s) => s.hfQuery);
  const setQuery = useModelBrowserStore((s) => s.setHfQuery);
  const submit = useModelBrowserStore((s) => s.submitHfInput);
  const submittedQuery = useModelBrowserStore((s) => s.hfSubmittedQuery);
  const searching = useModelBrowserStore((s) => s.hfSearching);
  const searched = useModelBrowserStore((s) => s.hfSearched);
  const results = useModelBrowserStore((s) => s.hfResults);
  const error = useModelBrowserStore((s) => s.hfError);
  const selectedRepo = useModelBrowserStore((s) => s.hfSelectedRepo);
  const repoFiles = useModelBrowserStore((s) => s.hfRepoFiles);
  const loadingRepos = useModelBrowserStore((s) => s.hfLoadingRepos);
  const selectRepo = useModelBrowserStore((s) => s.selectHfRepo);
  const back = useModelBrowserStore((s) => s.hfBack);
  const authors = useModelBrowserStore((s) => s.hfAuthors);
  const quants = useModelBrowserStore((s) => s.hfQuants);
  const filtersOpen = useModelBrowserStore((s) => s.hfFiltersOpen);
  const toggleFilters = useModelBrowserStore((s) => s.toggleHfFilters);

  // Both facets narrow the same result set: a repo has to satisfy each active
  // one to survive (AND across facets, OR within a facet). Each facet's own
  // counts are taken *after* the other facet has narrowed things, so a count
  // never advertises rows the current selection already rules out — picking
  // across the two can't dead-end on an empty list.
  const byAuthor = useMemo(
    () =>
      results.filter((r) => authors.length === 0 || authors.includes(r.author)),
    [results, authors],
  );
  const byQuant = useMemo(
    () =>
      results.filter(
        (r) => quants.length === 0 || quants.some((q) => r.quants.includes(q)),
      ),
    [results, quants],
  );
  const visible = useMemo(
    () =>
      byAuthor.filter(
        (r) => quants.length === 0 || quants.some((q) => r.quants.includes(q)),
      ),
    [byAuthor, quants],
  );

  const authorFacets = useMemo(
    () => facetCounts(byQuant.map((r) => r.author), authors),
    [byQuant, authors],
  );
  const quantFacets = useMemo(
    () => facetCounts(byAuthor.flatMap((r) => r.quants), quants),
    [byAuthor, quants],
  );

  const showingResults = searched && !selectedRepo;
  const facetsActive = authors.length + quants.length > 0;

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-6"
      onClick={close}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#16131f] text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4">
          <h2 className="flex items-center gap-2.5 text-lg">
            {/* Scaled by height with an auto width, so the mark keeps its
                aspect ratio whatever the source file's dimensions are. */}
            <img
              src={huggingfaceLogo}
              alt=""
              aria-hidden
              className="h-9 w-auto shrink-0"
            />
            <span>
              Add Model <em className="text-white/60">via</em>{" "}
              <strong className="font-semibold">HuggingFace</strong>
            </span>
          </h2>
          <button
            onClick={close}
            className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Toolbar: step-back, the search field, and the facet-sidebar toggle */}
        <div className="flex items-center gap-3 px-6">
          <button
            onClick={back}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/70 hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft size={16} /> Back
          </button>

          <div className="flex flex-1 items-center gap-2 rounded-lg border border-white/20 bg-white/5 px-4 py-3 focus-within:border-white/40">
            <MagnifyingGlass size={17} className="shrink-0 text-white/50" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder="Search models, or paste a repo (owner/name or URL)"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
            />
            {query ? (
              <button
                onClick={() => setQuery("")}
                title="Clear"
                className="shrink-0 rounded-md p-0.5 text-white/50 hover:bg-white/10 hover:text-white"
              >
                <X size={15} />
              </button>
            ) : null}
            <button
              onClick={() => void submit()}
              disabled={searching || !query.trim()}
              title="Search"
              className="shrink-0 rounded-md p-0.5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            >
              {searching ? (
                <CircleNotch size={17} className="animate-spin" />
              ) : (
                <ArrowRight size={17} />
              )}
            </button>
          </div>

          <button
            onClick={toggleFilters}
            disabled={!showingResults}
            title={filtersOpen ? "Hide filters" : "Show filters"}
            aria-pressed={filtersOpen}
            className={[
              "relative shrink-0 rounded-lg p-2 transition disabled:opacity-25",
              filtersOpen && showingResults
                ? "bg-white/10 text-white"
                : "text-white/60 hover:bg-white/10 hover:text-white",
            ].join(" ")}
          >
            <FadersHorizontal size={20} />
            {facetsActive ? (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" />
            ) : null}
          </button>
        </div>

        {/* What the list below is answering */}
        {showingResults ? (
          <div className="px-6 pt-4">
            <p className="truncate text-sm text-white/80">
              Searched for “{submittedQuery}”
            </p>
            <p className="mt-0.5 text-xs italic text-white/40">
              {facetsActive
                ? `${visible.length} of ${results.length} results`
                : `${results.length}${results.length >= HF_RESULT_LIMIT ? "+" : ""} results`}
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">
            <Warning size={14} weight="fill" /> {error}
          </div>
        ) : null}

        {/* Body */}
        <div className="flex min-h-0 flex-1 gap-5 overflow-hidden px-6 pt-4 pb-2">
          {showingResults && filtersOpen ? (
            <HfFilterSidebar
              authorFacets={authorFacets}
              quantFacets={quantFacets}
            />
          ) : null}

          <div className="min-w-0 flex-1 overflow-y-auto pr-1">
            {selectedRepo ? (
              <HfFileList
                repo={selectedRepo}
                files={repoFiles[selectedRepo] ?? null}
                loading={!!loadingRepos[selectedRepo]}
              />
            ) : searching ? (
              <div className="py-16 text-center text-sm text-white/40">
                Searching HuggingFace…
              </div>
            ) : visible.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                {visible.map((r) => (
                  <HfResultRow
                    key={r.id}
                    model={r}
                    selectedQuants={quants}
                    onOpen={() => void selectRepo(r.id)}
                  />
                ))}
              </div>
            ) : searched ? (
              <div className="py-16 text-center text-sm text-white/40">
                {facetsActive
                  ? "No models match these filters."
                  : "No GGUF models found. Try another search, or paste a repo id."}
              </div>
            ) : (
              <HfEmptyPrompt />
            )}
          </div>
        </div>

        {/* Standing reminder of what a download here can and can't do */}
        <p className="flex items-center gap-1.5 border-t border-white/10 px-6 py-3 text-[11px] text-white/40">
          <ShieldCheck size={13} className="shrink-0 text-emerald-300/70" />
          Only <code className="text-white/60">.gguf</code> files are downloaded,
          and every model runs locally — nothing is executed on fetch.
        </p>
      </div>
    </div>
  );
}

/** The pre-search state: say what this panel does and how to start. */
function HfEmptyPrompt() {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <MagnifyingGlass size={26} className="text-white/25" />
      <p className="text-sm text-white/60">Search HuggingFace for a model</p>
      <p className="max-w-sm text-xs leading-relaxed text-white/35">
        Try “qwen coder”, “llama 3”, or “gemma”. Already know the repo? Paste
        its id (<code className="text-white/50">owner/name</code>) or URL to jump
        straight to its downloadable files.
      </p>
    </div>
  );
}

/** Faceted narrowing over the current result set, plus the server-side sort. */
function HfFilterSidebar({
  authorFacets,
  quantFacets,
}: {
  authorFacets: Facet[];
  quantFacets: Facet[];
}) {
  const sort = useModelBrowserStore((s) => s.hfSort);
  const setSort = useModelBrowserStore((s) => s.setHfSort);
  const authors = useModelBrowserStore((s) => s.hfAuthors);
  const quants = useModelBrowserStore((s) => s.hfQuants);
  const toggleAuthor = useModelBrowserStore((s) => s.toggleHfAuthor);
  const toggleQuant = useModelBrowserStore((s) => s.toggleHfQuant);
  const clearFacets = useModelBrowserStore((s) => s.clearHfFacets);

  const [open, setOpen] = useState({ sort: true, author: false, quant: false });
  const toggle = (k: keyof typeof open) =>
    setOpen((o) => ({ ...o, [k]: !o[k] }));

  return (
    <aside className="w-44 shrink-0 overflow-y-auto pb-4">
      <div className="mb-2 flex items-center justify-between gap-1 px-1">
        <span className="inline-flex items-center gap-1.5 text-sm text-white/70">
          <Funnel size={14} /> Filter
        </span>
        {authors.length + quants.length > 0 ? (
          <button
            onClick={clearFacets}
            className="rounded px-1 py-0.5 text-[10px] text-white/40 hover:bg-white/10 hover:text-white"
          >
            Clear
          </button>
        ) : null}
      </div>

      <FacetSection
        label="Sort By"
        role="radiogroup"
        open={open.sort}
        onToggle={() => toggle("sort")}
      >
        {HF_SORTS.map((s) => (
          <FacetOption
            key={s.id}
            kind="radio"
            checked={sort === s.id}
            label={s.label}
            onToggle={() => setSort(s.id)}
          />
        ))}
      </FacetSection>

      <FacetSection
        label="Created By"
        count={authors.length}
        open={open.author}
        onToggle={() => toggle("author")}
      >
        {authorFacets.map((f) => (
          <FacetOption
            key={f.value}
            kind="check"
            checked={authors.includes(f.value)}
            label={f.value}
            count={f.count}
            onToggle={() => toggleAuthor(f.value)}
          />
        ))}
      </FacetSection>

      <FacetSection
        label="Quantizations"
        count={quants.length}
        open={open.quant}
        onToggle={() => toggle("quant")}
      >
        {quantFacets.length === 0 ? (
          <p className="px-1 py-1 text-[11px] text-white/30">
            No quants detected.
          </p>
        ) : (
          quantFacets.map((f) => (
            <FacetOption
              key={f.value}
              kind="check"
              checked={quants.includes(f.value)}
              label={prettyQuant(f.value)}
              // The canonical label is what matches the filename, so keep it
              // reachable on hover even though the row reads the pretty form.
              title={f.value}
              count={f.count}
              onToggle={() => toggleQuant(f.value)}
            />
          ))
        )}
      </FacetSection>
    </aside>
  );
}

function FacetSection({
  label,
  count = 0,
  open,
  onToggle,
  role,
  children,
}: {
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  /** ARIA role for the option list — "radiogroup" for single-choice sections. */
  role?: "radiogroup" | "group";
  children: ReactNode;
}) {
  return (
    <div className="border-t border-white/10 first:border-t-0">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-2.5 text-left text-sm text-white/75 hover:text-white"
      >
        <span className="truncate">
          {label}
          {count > 0 ? (
            <span className="ml-1 text-[11px] text-amber-300/80">({count})</span>
          ) : null}
        </span>
        <CaretDown
          size={13}
          className={[
            "shrink-0 text-white/40 transition-transform duration-200",
            open ? "" : "-rotate-90",
          ].join(" ")}
        />
      </button>
      <Collapse open={open}>
        <div
          role={role}
          aria-label={role ? label : undefined}
          className="max-h-44 overflow-y-auto pb-2"
        >
          {children}
        </div>
      </Collapse>
    </div>
  );
}

function FacetOption({
  kind,
  checked,
  label,
  count,
  title,
  onToggle,
}: {
  kind: "radio" | "check";
  checked: boolean;
  label: string;
  count?: number;
  /** Hover text, when the visible label is a shortened form of the real value. */
  title?: string;
  onToggle: () => void;
}) {
  return (
    <button
      role={kind === "radio" ? "radio" : "checkbox"}
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-white/5"
    >
      <span
        className={[
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center border transition",
          kind === "radio" ? "rounded-full" : "rounded-[4px]",
          checked ? "border-amber-400 bg-amber-400" : "border-white/25",
        ].join(" ")}
      >
        {checked ? (
          <span
            className={[
              "bg-[#16131f]",
              kind === "radio" ? "h-1.5 w-1.5 rounded-full" : "h-1.5 w-1.5 rounded-[1px]",
            ].join(" ")}
          />
        ) : null}
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate text-[11px]",
          checked ? "text-white" : "text-white/60",
        ].join(" ")}
        title={title ?? label}
      >
        {label}
      </span>
      {count != null ? (
        <span className="shrink-0 text-[10px] text-white/30">{count}</span>
      ) : null}
    </button>
  );
}

/**
 * One repo, shown through the quant it stands for. Download opens the repo's
 * full quant list rather than downloading anything — the row is a way in, not
 * a commitment to that one file.
 */
function HfResultRow({
  model,
  selectedQuants,
  onOpen,
}: {
  model: HfModel;
  selectedQuants: string[];
  onOpen: () => void;
}) {
  const quant = representativeQuant(model.quants, selectedQuants);

  const meta = [
    formatParameters(model.params),
    pipelineLabel(model.pipelineTag),
    quant ? prettyQuant(quant) : null,
  ].filter(Boolean) as string[];

  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-4 rounded-xl bg-white/[0.06] px-4 py-3.5 text-left transition hover:bg-white/[0.1]"
    >
      <AuthorAvatar author={model.author} />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm text-white/60">{model.author}</span>
        <span className="truncate text-[15px] font-medium">{model.name}</span>

        <span
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] italic text-white/45"
          title={quant ?? undefined}
        >
          <span className="inline-flex items-center gap-1 not-italic">
            <Heart size={11} weight="fill" /> {formatCount(model.likes)}
          </span>
          {meta.map((m) => (
            <span key={m} className="before:mr-2 before:content-['•']">
              {m}
            </span>
          ))}
        </span>
      </div>

      <span className="inline-flex shrink-0 items-center gap-1.5 py-2 text-xs font-medium text-white/70 transition group-hover:text-white">
        View &amp; Download Variants
        <CaretRight size={14} />
      </span>
    </button>
  );
}

function HfFileList({
  repo,
  files,
  loading,
}: {
  repo: string;
  files: HfGgufFile[] | null;
  loading: boolean;
}) {
  const author = repo.split("/")[0] ?? repo;
  const name = repo.split("/")[1] ?? repo;

  // What the page is actually offering: distinct quants you can download. A
  // repo can list the same quant more than once (whole plus shards) and can
  // carry files that are no quant at all, so this is neither the file count
  // nor the row count.
  const quantCount = files
    ? new Set(
        files.filter((f) => !f.sharded && f.quant).map((f) => f.quant),
      ).size
    : 0;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3 pb-1">
        <AuthorAvatar author={author} size={32} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-white/50">{author}</span>
          <span className="truncate text-sm font-medium">{name}</span>
        </div>
        <div className="flex-1" />
        {quantCount > 0 ? (
          <span className="shrink-0 text-xs italic text-white/40">
            {quantCount} {quantCount === 1 ? "quant" : "quants"}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="py-14 text-center text-sm text-white/40">
          Loading files…
        </div>
      ) : files && files.length > 0 ? (
        files.map((f) => <HfFileRow key={f.filename} repo={repo} file={f} />)
      ) : (
        <div className="py-14 text-center text-sm text-white/40">
          No .gguf files in this repo.
        </div>
      )}
    </div>
  );
}

function HfFileRow({ repo, file }: { repo: string; file: HfGgufFile }) {
  const download = useModelBrowserStore((s) => s.downloads[file.filename]);
  const isInstalled = useModelBrowserStore((s) => s.isInstalled(file.filename));
  const cancel = useModelBrowserStore((s) => s.cancel);
  const downloadHfFile = useModelBrowserStore((s) => s.downloadHfFile);

  return (
    <div className="flex items-center gap-3 rounded-lg bg-white/[0.06] px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{file.filename}</span>
        <span className="text-[11px] italic text-white/40">
          {file.quant ? `${prettyQuant(file.quant)} • ` : ""}
          {formatBytes(file.sizeBytes)}
          {file.sharded ? " • multi-part model" : ""}
        </span>
      </div>

      {download ? (
        <DownloadRow
          filename={file.filename}
          onCancel={() => void cancel(file.filename)}
        />
      ) : isInstalled ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-400/20 px-3 py-1.5 text-xs font-medium text-emerald-200">
          <CheckCircle size={13} weight="fill" /> Installed
        </span>
      ) : file.sharded ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-white/40"
          title="Multi-part (sharded) models aren't supported yet — a single shard can't be loaded on its own."
        >
          <Warning size={12} weight="fill" /> Unsupported
        </span>
      ) : (
        <button
          onClick={() => downloadHfFile(repo, file)}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-xs font-medium hover:bg-white/20"
        >
          <DownloadSimple size={14} />
          Download
          <span className="text-white/45">• {formatBytes(file.sizeBytes)}</span>
        </button>
      )}
    </div>
  );
}

function RamGateDialog({ model }: { model: CuratedModel }) {
  const dismiss = useModelBrowserStore((s) => s.dismissRamGate);
  const confirm = useModelBrowserStore((s) => s.confirmDownload);
  const showWhatFits = useModelBrowserStore((s) => s.showWhatFits);
  const hardware = useRuntimeStore((s) => s.hardware);

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-6"
      onClick={dismiss}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-amber-400/20 bg-[#1b1626] p-5 text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2 text-amber-300">
          <Warning size={18} weight="fill" />
          <h3 className="text-sm font-semibold">Not enough RAM</h3>
        </div>
        <p className="text-xs leading-relaxed text-white/70">
          {model.name} requires {model.minRamGb}GB RAM. Your system has{" "}
          {hardware ? Math.round(hardware.totalRamGb) : "?"}GB. Running it may
          cause slowdowns or crashes.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={showWhatFits}
            className="rounded-lg px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
          >
            Show me what fits
          </button>
          <button
            onClick={() => void confirm(model)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400/20 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-400/30"
          >
            <ArrowCounterClockwise size={13} /> Download Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
