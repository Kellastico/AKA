import { useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  CheckCircle,
  CircleNotch,
  Cube,
  DownloadSimple,
  FilePlus,
  FolderOpen,
  Heart,
  MagnifyingGlass,
  ShieldCheck,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  allBrowserModels,
  useModelBrowserStore,
  type ModelFilter,
} from "./use-model-browser-store";
import { formatContext, type CuratedModel } from "./curated-models";
import { useRuntimeStore } from "./use-runtime-store";
import {
  modelsDirPath,
  openModelsFolder,
  type HfGgufFile,
} from "../../lib/tauri/commands";

const FILTERS: { id: ModelFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "light", label: "Light" },
  { id: "standard", label: "Standard" },
  { id: "pro", label: "Pro" },
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

  const models = allBrowserModels(localModels);
  const visible = models.filter((m) => {
    if (filter === "all") return true;
    if (filter === "installed")
      return localModels.some((l) => l.filename === m.filename);
    return m.tier === filter;
  });

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

        {/* Hardware banner */}
        <div className="border-b border-white/10 bg-white/5 px-5 py-2 text-xs text-white/70">
          {hardware ? (
            <span>
              {gpuLabel(hardware.gpuType)} · {Math.round(hardware.totalRamGb)}GB
              RAM ·{" "}
              <span className="capitalize">{hardware.recommendedTier}</span> tier
            </span>
          ) : (
            <span className="text-white/40">
              Hardware details unavailable in browser preview
            </span>
          )}
        </div>

        {/* Where downloads live — click to reveal in the OS file manager. */}
        {modelsPath ? (
          <button
            onClick={() => void openModelsFolder()}
            className="group flex w-full items-center gap-1.5 border-b border-white/10 px-5 py-1.5 text-left text-[11px] text-white/40 hover:bg-white/5 hover:text-white/70"
            title="Open in file manager"
          >
            <FolderOpen size={12} className="shrink-0" />
            <span className="shrink-0">Saved to</span>
            <span className="truncate font-mono text-white/55 group-hover:text-white/80">
              {modelsPath}
            </span>
          </button>
        ) : null}

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
            <div className="col-span-full py-8 text-center text-sm text-white/40">
              No models in this filter.
            </div>
          ) : null}
        </div>
      </div>

      {ramGateModel ? <RamGateDialog model={ramGateModel} /> : null}
      {hfPanelOpen ? <HfPanel /> : null}
    </div>
  );
}

function ModelCard({ model }: { model: CuratedModel }) {
  const download = useModelBrowserStore((s) => s.downloads[model.filename]);
  const isInstalled = useModelBrowserStore((s) => s.isInstalled(model.filename));
  const isActive = useModelBrowserStore((s) => s.isActive(model.filename));
  const requestDownload = useModelBrowserStore((s) => s.requestDownload);
  const cancel = useModelBrowserStore((s) => s.cancel);
  const remove = useModelBrowserStore((s) => s.remove);
  const loadModel = useModelBrowserStore((s) => s.loadModel);
  const unloadModel = useModelBrowserStore((s) => s.unloadModel);
  const isLoading = useModelBrowserStore((s) => s.loadingModel === model.filename);
  const hardware = useRuntimeStore((s) => s.hardware);

  const downloadable = model.huggingfaceRepo !== "";
  const ramInsufficient =
    !!hardware && hardware.totalRamGb > 0 && model.minRamGb > hardware.totalRamGb;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Cube size={15} weight="fill" className="shrink-0 text-amber-300/80" />
          <span className="truncate text-sm font-medium">{model.name}</span>
        </div>
        {model.verified ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[10px] text-emerald-300/80"
            title="ÄKÄ-tested"
          >
            <CheckCircle size={12} weight="fill" /> Verified
          </span>
        ) : (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[10px] text-amber-300/80"
            title="This model hasn't been verified with ÄKÄ. It may not load correctly."
          >
            <Warning size={12} weight="fill" /> Unverified
          </span>
        )}
      </div>

      <p className="line-clamp-2 text-xs text-white/50">{model.description}</p>

      <div className="flex flex-wrap gap-1">
        {model.tags.map((t) => (
          <span
            key={t}
            className="rounded bg-white/10 px-1.5 py-px text-[10px] text-white/60"
          >
            {t}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-white/40">
        <span>{formatGb(model.sizeGb)}</span>
        {model.minRamGb > 0 ? <span>Needs {model.minRamGb}GB</span> : null}
        {model.contextWindow > 0 ? (
          <span>{formatContext(model.contextWindow)}</span>
        ) : null}
      </div>

      {/* State-aware action row */}
      <div className="mt-1 flex items-center gap-2">
        {download ? (
          <DownloadRow filename={model.filename} onCancel={() => void cancel(model.filename)} />
        ) : isActive ? (
          <>
            <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-400/20 px-2.5 py-1.5 text-xs font-medium text-emerald-200">
              <CheckCircle size={13} weight="fill" /> Active
            </span>
            <button
              onClick={() => void unloadModel()}
              className="rounded-lg px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/10 hover:text-white"
            >
              Unload
            </button>
          </>
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
        ) : downloadable ? (
          <button
            onClick={() => requestDownload(model)}
            disabled={ramInsufficient}
            title={
              ramInsufficient
                ? `Needs ${model.minRamGb}GB RAM — more than this machine has`
                : undefined
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-2.5 py-1.5 text-xs text-white hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <DownloadSimple size={13} /> Download
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

function HfPanel() {
  const close = useModelBrowserStore((s) => s.closeHfPanel);
  const query = useModelBrowserStore((s) => s.hfQuery);
  const setQuery = useModelBrowserStore((s) => s.setHfQuery);
  const submit = useModelBrowserStore((s) => s.submitHfInput);
  const searching = useModelBrowserStore((s) => s.hfSearching);
  const searched = useModelBrowserStore((s) => s.hfSearched);
  const results = useModelBrowserStore((s) => s.hfResults);
  const error = useModelBrowserStore((s) => s.hfError);
  const selectedRepo = useModelBrowserStore((s) => s.hfSelectedRepo);
  const files = useModelBrowserStore((s) => s.hfFiles);
  const loadingFiles = useModelBrowserStore((s) => s.hfLoadingFiles);
  const selectRepo = useModelBrowserStore((s) => s.selectHfRepo);
  const back = useModelBrowserStore((s) => s.backToHfResults);

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-6"
      onClick={close}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#16131f] text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-base font-semibold">Add Model (via Huggingface)</h2>
          <button
            onClick={close}
            className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search input */}
        <div className="flex flex-col gap-2 border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2">
              <MagnifyingGlass size={15} className="shrink-0 text-white/40" />
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
            </div>
            <button
              onClick={() => void submit()}
              disabled={searching || !query.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400/20 px-3 py-2 text-xs text-amber-100 hover:bg-amber-400/30 disabled:opacity-40"
            >
              {searching ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <MagnifyingGlass size={14} />
              )}
              Search
            </button>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-white/40">
            <ShieldCheck size={13} className="text-emerald-300/70" />
            Only <code className="text-white/60">.gguf</code> files are
            downloaded, and every model runs locally — nothing is executed on
            fetch.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {error ? (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">
              <Warning size={14} weight="fill" /> {error}
            </div>
          ) : null}

          {selectedRepo ? (
            <HfFileList
              repo={selectedRepo}
              files={files}
              loading={loadingFiles}
              onBack={back}
            />
          ) : searching ? (
            <div className="py-10 text-center text-sm text-white/40">
              Searching HuggingFace…
            </div>
          ) : results.length > 0 ? (
            <div className="flex flex-col gap-2">
              {results.map((r) => (
                <button
                  key={r.id}
                  onClick={() => void selectRepo(r.id)}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-left hover:bg-white/10"
                >
                  <span className="min-w-0 truncate text-sm">{r.id}</span>
                  <span className="flex shrink-0 items-center gap-3 text-[11px] text-white/40">
                    <span className="inline-flex items-center gap-1">
                      <DownloadSimple size={12} /> {formatCount(r.downloads)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Heart size={12} /> {formatCount(r.likes)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : searched ? (
            <div className="py-10 text-center text-sm text-white/40">
              No GGUF models found. Try another search, or paste a repo id.
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-white/40">
              Search for a model (e.g. “qwen coder”) or paste a HuggingFace repo
              to see its downloadable files.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HfFileList({
  repo,
  files,
  loading,
  onBack,
}: {
  repo: string;
  files: HfGgufFile[] | null;
  loading: boolean;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft size={13} /> Back
        </button>
        <span className="min-w-0 truncate text-sm font-medium text-white/80">
          {repo}
        </span>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-white/40">
          Loading files…
        </div>
      ) : files && files.length > 0 ? (
        files.map((f) => <HfFileRow key={f.filename} repo={repo} file={f} />)
      ) : (
        <div className="py-10 text-center text-sm text-white/40">
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
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{file.filename}</span>
        <span className="text-[11px] text-white/40">
          {formatBytes(file.sizeBytes)}
          {file.sharded ? " · multi-part model" : ""}
        </span>
      </div>

      {download ? (
        <DownloadRow
          filename={file.filename}
          onCancel={() => void cancel(file.filename)}
        />
      ) : isInstalled ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-400/20 px-2.5 py-1.5 text-xs font-medium text-emerald-200">
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
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white/15 px-2.5 py-1.5 text-xs text-white hover:bg-white/25"
        >
          <DownloadSimple size={13} /> Download
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
