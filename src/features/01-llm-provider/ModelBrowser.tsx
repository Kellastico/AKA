import {
  ArrowCounterClockwise,
  CheckCircle,
  CircleNotch,
  Cube,
  DownloadSimple,
  FilePlus,
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
  const hardware = useRuntimeStore((s) => s.hardware);

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

function RamGateDialog({ model }: { model: CuratedModel }) {
  const dismiss = useModelBrowserStore((s) => s.dismissRamGate);
  const confirm = useModelBrowserStore((s) => s.confirmDownload);
  const showWhatFits = useModelBrowserStore((s) => s.showWhatFits);
  const hardware = useRuntimeStore((s) => s.hardware);

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 p-6"
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
