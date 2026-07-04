import { useEffect, useState } from "react";
import {
  ArrowsClockwise,
  ArrowSquareOut,
  Cube,
  PencilSimple,
  Play,
  Plus,
  Plugs,
  PlugsConnected,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import {
  BUILTIN_RUNTIME_NAME,
  builtinEndpoint,
  RUNTIME_INSTALL_URLS,
  runtimeSortRank,
  useRuntimeStore,
} from "./use-runtime-store";
import { openExternalUrl } from "../../lib/tauri/commands";
import type { DetectedRuntime, SidecarStatusValue } from "../../lib/tauri/commands";
import { AllowlistSection } from "./AllowlistSection";

export function ConnectionPanel({ onDone }: { onDone?: () => void }) {
  const detected = useRuntimeStore((s) => s.detected);
  const detecting = useRuntimeStore((s) => s.detecting);
  const active = useRuntimeStore((s) => s.active);
  const refresh = useRuntimeStore((s) => s.refreshDetection);
  const selectDetected = useRuntimeStore((s) => s.selectDetected);
  const startRuntime = useRuntimeStore((s) => s.startRuntime);
  const stopRuntime = useRuntimeStore((s) => s.stopRuntime);
  const saveManual = useRuntimeStore((s) => s.saveManual);
  const savedRuntimes = useRuntimeStore((s) => s.savedRuntimes);
  const deleteSavedRuntime = useRuntimeStore((s) => s.deleteSavedRuntime);
  const editSavedRuntime = useRuntimeStore((s) => s.editSavedRuntime);
  const activeHealthy = useRuntimeStore((s) => s.healthy);
  const pushToast = useRuntimeStore((s) => s.pushToast);

  const builtinStatus = useRuntimeStore((s) => s.builtinStatus);
  const builtinPort = useRuntimeStore((s) => s.builtinPort);
  const builtinError = useRuntimeStore((s) => s.builtinError);
  const selectBuiltin = useRuntimeStore((s) => s.selectBuiltin);
  const restartBuiltin = useRuntimeStore((s) => s.restartBuiltin);

  const builtinActive =
    builtinPort != null && active?.baseUrl === builtinEndpoint(builtinPort);

  const [showManual, setShowManual] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  // Inline editor for a saved (custom) runtime — base URL of the one being edited.
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Show every known runtime, sorted running → installed-but-stopped → not
  // installed. Not-installed rows render as dimmed "Install" links (rather than
  // being hidden), so users can discover and grab the ones they don't have.
  const ranked = [...detected].sort((a, b) => runtimeSortRank(a) - runtimeSortRank(b));
  const anyHealthy = detected.some((d) => d.healthy);
  const showEmptyHelper = !detecting && detected.length > 0 && !anyHealthy;

  const savedUrls = new Set(savedRuntimes.map((s) => s.baseUrl));
  const builtinUrl = builtinPort != null ? builtinEndpoint(builtinPort) : null;
  const detectedByUrl = new Map(detected.map((d) => [d.baseUrl, d] as const));
  // Detected section = runtimes NOT yet in the saved list (discover / install
  // more). Installed local ones get folded into "Saved runtimes" automatically.
  const detectedUnsaved = ranked.filter((r) => !savedUrls.has(r.baseUrl));
  // Saved section = the permanent list (the built-in is shown separately above).
  const savedList = savedRuntimes.filter((s) => s.baseUrl !== builtinUrl);

  const beginEdit = (baseUrl: string, apiKey: string | null) => {
    setEditingUrl(baseUrl);
    setEditUrl(baseUrl);
    setEditKey(apiKey ?? "");
    setEditError(null);
  };

  return (
    <div className="flex flex-col gap-3 px-1 py-1 text-white">
      <BuiltinRuntimeRow
        status={builtinStatus}
        error={builtinError}
        active={builtinActive}
        onSelect={async () => {
          await selectBuiltin();
          onDone?.();
        }}
        onRestart={() => {
          void restartBuiltin();
        }}
      />

      <div className="h-px bg-white/10" />

      {/* Saved (permanent) runtimes first — these are the user's own, more
          relevant than the "install these" detected list below. */}
      {savedList.length > 0 ? (
        <>
          <div className="px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
              Saved runtimes
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {savedList.map((s) => {
              const det = detectedByUrl.get(s.baseUrl);
              const isActive = active?.baseUrl === s.baseUrl;
              // Health: live from the local probe when detected, else the active
              // runtime's known health, else unknown (neutral) for an idle remote.
              const healthy = det ? det.healthy : isActive ? activeHealthy : undefined;
              const isCustom = !det; // custom/remote endpoints are editable
              return editingUrl === s.baseUrl ? (
                <EndpointForm
                  key={s.baseUrl}
                  url={editUrl}
                  setUrl={setEditUrl}
                  apiKey={editKey}
                  setApiKey={setEditKey}
                  saving={editSaving}
                  error={editError}
                  saveLabel="Update"
                  onCancel={() => setEditingUrl(null)}
                  onSave={async () => {
                    setEditSaving(true);
                    setEditError(null);
                    const res = await editSavedRuntime(s.baseUrl, editUrl, editKey || null);
                    setEditSaving(false);
                    if (!res.ok) {
                      setEditError(res.error ?? "Failed to validate endpoint");
                      return;
                    }
                    setEditingUrl(null);
                  }}
                />
              ) : (
                <SavedRuntimeRow
                  key={s.baseUrl}
                  name={s.name}
                  baseUrl={s.baseUrl}
                  healthy={healthy}
                  active={isActive}
                  managed={det?.managed ?? false}
                  launchable={det?.launchable ?? false}
                  installed={det?.installed ?? false}
                  editable={isCustom}
                  onSelect={async () => {
                    if (det) {
                      await selectDetected(det);
                      onDone?.();
                      return;
                    }
                    const res = await saveManual(s.baseUrl, s.apiKey);
                    if (!res.ok) {
                      pushToast({
                        kind: "error",
                        text: res.error ?? "Couldn't connect to this runtime.",
                      });
                      return;
                    }
                    onDone?.();
                  }}
                  onStart={det ? () => startRuntime(det.name) : undefined}
                  onStop={det ? () => stopRuntime(det.name) : undefined}
                  onEdit={isCustom ? () => beginEdit(s.baseUrl, s.apiKey) : undefined}
                  onDelete={() => void deleteSavedRuntime(s.baseUrl)}
                />
              );
            })}
          </div>
        </>
      ) : null}

      <div className="h-px bg-white/10" />

      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
          Detected runtimes
        </span>
        <button
          onClick={() => refresh()}
          disabled={detecting}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-50"
          title="Re-probe"
        >
          <ArrowsClockwise size={12} className={detecting ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {detecting && detected.length === 0 ? (
        <div className="px-2 text-xs text-white/50">Probing local ports…</div>
      ) : null}

      {detectedUnsaved.length > 0 ? (
        <div className="flex flex-col gap-1">
          {detectedUnsaved.map((r) => (
            <RuntimeRow
              key={r.baseUrl}
              runtime={r}
              active={active?.baseUrl === r.baseUrl}
              onSelect={async () => {
                await selectDetected(r);
                onDone?.();
              }}
              onStart={() => startRuntime(r.name)}
              onStop={() => stopRuntime(r.name)}
              installUrl={RUNTIME_INSTALL_URLS[r.name]}
            />
          ))}
        </div>
      ) : !detecting ? (
        <div className="px-2 text-[11px] text-white/40">
          All detected runtimes are saved above.
        </div>
      ) : null}

      {showEmptyHelper ? (
        <div className="mx-1 rounded-xl border border-white/10 bg-white/5 p-3 text-xs leading-relaxed text-white/70">
          {builtinStatus === "ready" ? (
            <>
              None of these are running — but the{" "}
              <span className="font-medium text-white">ÄKÄ Built-in</span>{" "}
              runtime above is ready to use with no setup. Or start a detected
              runtime, or add a custom endpoint.
            </>
          ) : (
            <>
              Nothing's running yet. Start one of the runtimes above (or add a
              custom endpoint below), then refresh.
            </>
          )}
        </div>
      ) : null}

      <div className="h-px bg-white/10" />

      {!showManual ? (
        <button
          onClick={() => setShowManual(true)}
          className="inline-flex items-center gap-2 rounded-xl px-2 py-2 text-xs text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Plus size={12} />
          Add custom endpoint
        </button>
      ) : (
        <EndpointForm
          url={manualUrl}
          setUrl={setManualUrl}
          apiKey={manualKey}
          setApiKey={setManualKey}
          saving={saving}
          error={manualError}
          saveLabel="Save"
          onCancel={() => {
            setShowManual(false);
            setManualError(null);
          }}
          onSave={async () => {
            setSaving(true);
            setManualError(null);
            const result = await saveManual(manualUrl, manualKey || null);
            setSaving(false);
            if (!result.ok) {
              setManualError(result.error ?? "Failed to validate endpoint");
              return;
            }
            setShowManual(false);
            setManualUrl("");
            setManualKey("");
            onDone?.();
          }}
        />
      )}

      <div className="h-px bg-white/10" />

      <AllowlistSection />
    </div>
  );
}

/** Maps the sidecar status to a status-dot color. */
function statusDotClass(status: SidecarStatusValue): string {
  switch (status) {
    case "ready":
      return "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]";
    case "starting":
    case "restarting":
      return "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]";
    case "error":
      return "bg-red-400";
    case "stopped":
    default:
      return "bg-white/30";
  }
}

function statusLabel(status: SidecarStatusValue): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "starting":
      return "Starting…";
    case "restarting":
      return "Restarting…";
    case "error":
      return "Error";
    case "stopped":
    default:
      return "Stopped";
  }
}

/**
 * The ÄKÄ Built-in runtime entry. Always first, always present — managed by
 * ÄKÄ, so there is no delete action; only a restart. A live status dot tracks
 * the sidecar lifecycle.
 */
function BuiltinRuntimeRow({
  status,
  error,
  active,
  onSelect,
  onRestart,
}: {
  status: SidecarStatusValue;
  error: string | null;
  active: boolean;
  onSelect: () => void;
  onRestart: () => void;
}) {
  const selectable = status === "ready";
  return (
    <div
      className={[
        "group flex w-full items-center gap-2 rounded-xl px-2 py-2 transition",
        active ? "bg-white/15" : "hover:bg-white/10",
      ].join(" ")}
    >
      <span
        style={{ width: 8, height: 8 }}
        className={["inline-block shrink-0 rounded-full", statusDotClass(status)].join(" ")}
        title={statusLabel(status)}
      />
      <Cube size={14} weight="fill" className="shrink-0 text-amber-300/80" />
      <button
        onClick={onSelect}
        disabled={!selectable}
        className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-default"
        title={selectable ? "Use the built-in runtime" : statusLabel(status)}
      >
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs text-white">{BUILTIN_RUNTIME_NAME}</span>
          <span
            className="rounded bg-amber-400/20 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-200"
            title="Managed by ÄKÄ — no setup required"
          >
            Built-in
          </span>
        </span>
        <span className="truncate text-[10px] text-white/40">
          {error ??
            (status === "ready" ? "Ready · no setup needed" : statusLabel(status))}
        </span>
      </button>
      <button
        onClick={onRestart}
        className="shrink-0 rounded-lg p-1 text-white/50 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
        title="Restart runtime"
      >
        <ArrowsClockwise
          size={13}
          className={status === "restarting" ? "animate-spin" : ""}
        />
      </button>
    </div>
  );
}

function RuntimeRow({
  runtime,
  active,
  onSelect,
  onStart,
  onStop,
  installUrl,
}: {
  runtime: DetectedRuntime;
  active: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  installUrl?: string;
}) {
  // Not installed and not running → a dimmed, informational row with an Install
  // link instead of a connect action.
  if (!runtime.healthy && !runtime.installed) {
    return (
      <div className="flex w-full items-center gap-2 rounded-xl px-2 py-2 opacity-60">
        <span
          style={{ width: 8, height: 8 }}
          className="inline-block shrink-0 rounded-full bg-white/20"
        />
        <Plugs size={14} className="text-white/30" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-white/70">{runtime.name}</span>
          <span className="truncate text-[10px] text-white/35">Not installed</span>
        </div>
        {installUrl ? (
          <button
            onClick={() => void openExternalUrl(installUrl)}
            title={`Install ${runtime.name}`}
            className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
          >
            Install
            <ArrowSquareOut size={11} />
          </button>
        ) : null}
      </div>
    );
  }

  // Running or installed-but-stopped → a selectable row. When AKA can manage
  // the process it also offers Play (boot) / Stop (kill).
  const canPlay =
    runtime.launchable && runtime.installed && !runtime.healthy && !runtime.managed;
  return (
    <div
      className={[
        "group flex w-full items-center gap-2 rounded-xl px-2 py-2 transition",
        active ? "bg-white/15" : "hover:bg-white/10",
      ].join(" ")}
    >
      <HealthDot healthy={runtime.healthy} />
      {runtime.healthy ? (
        <PlugsConnected size={14} className="text-white/60" />
      ) : (
        <Plugs size={14} className="text-white/40" />
      )}
      <button
        onClick={onSelect}
        title={runtime.healthy ? "Connected — click to use" : "Installed but not running"}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="truncate text-xs text-white">{runtime.name}</span>
        <span className="truncate text-[10px] text-white/40">
          {runtime.managed && !runtime.healthy ? "Starting…" : runtime.baseUrl}
        </span>
      </button>
      {runtime.managed ? (
        <button
          onClick={onStop}
          title={`Stop ${runtime.name} — shuts down the server AKA started`}
          className="shrink-0 rounded-lg p-1 text-white/50 transition hover:bg-white/10 hover:text-red-300"
        >
          <Stop size={14} weight="fill" />
        </button>
      ) : canPlay ? (
        <button
          onClick={onStart}
          title={`Start ${runtime.name} — boots the server in the background`}
          className="shrink-0 rounded-lg p-1 text-white/50 opacity-0 transition hover:bg-white/10 hover:text-emerald-300 group-hover:opacity-100"
        >
          <Play size={14} weight="fill" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A row in the permanent "Saved runtimes" list. Covers both used local runtimes
 * (folded in from detection — live health + Play/Stop) and custom/remote
 * endpoints (editable URL/key). Health: green/red when known, neutral when an
 * idle remote endpoint hasn't been probed. Delete removes it from the list (and
 * won't be auto-re-added). The built-in is never rendered here.
 */
function SavedRuntimeRow({
  name,
  baseUrl,
  healthy,
  active,
  managed,
  launchable,
  installed,
  editable,
  onSelect,
  onStart,
  onStop,
  onEdit,
  onDelete,
}: {
  name: string;
  baseUrl: string;
  healthy: boolean | undefined;
  active: boolean;
  managed: boolean;
  launchable: boolean;
  installed: boolean;
  editable: boolean;
  onSelect: () => void;
  onStart?: () => void;
  onStop?: () => void;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const canPlay = launchable && installed && !healthy && !managed;
  return (
    <div
      className={[
        "group flex w-full items-center gap-2 rounded-xl px-2 py-2 transition",
        active ? "bg-white/15" : "hover:bg-white/10",
      ].join(" ")}
    >
      {healthy === undefined ? (
        <span
          style={{ width: 8, height: 8 }}
          className="inline-block shrink-0 rounded-full bg-white/25"
          title="Health unknown — connect to check"
        />
      ) : (
        <HealthDot healthy={healthy} />
      )}
      {healthy ? (
        <PlugsConnected size={14} className="text-white/60" />
      ) : (
        <Plugs size={14} className="text-white/40" />
      )}
      <button
        onClick={onSelect}
        title="Connect to this runtime"
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="truncate text-xs text-white">{name}</span>
        <span className="truncate text-[10px] text-white/40">{baseUrl}</span>
      </button>
      {managed && onStop ? (
        <button
          onClick={onStop}
          title={`Stop ${name} — shuts down the server AKA started`}
          className="shrink-0 rounded-lg p-1 text-white/50 transition hover:bg-white/10 hover:text-red-300"
        >
          <Stop size={14} weight="fill" />
        </button>
      ) : canPlay && onStart ? (
        <button
          onClick={onStart}
          title={`Start ${name} — boots the server in the background`}
          className="shrink-0 rounded-lg p-1 text-white/50 opacity-0 transition hover:bg-white/10 hover:text-emerald-300 group-hover:opacity-100"
        >
          <Play size={14} weight="fill" />
        </button>
      ) : null}
      {editable && onEdit ? (
        <button
          onClick={onEdit}
          title="Edit endpoint / API key"
          className="shrink-0 rounded-lg p-1 text-white/40 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
        >
          <PencilSimple size={12} />
        </button>
      ) : null}
      <button
        onClick={onDelete}
        title="Remove from saved runtimes"
        className="shrink-0 rounded-lg p-1 text-white/40 opacity-0 transition hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
      >
        <Trash size={13} />
      </button>
    </div>
  );
}

/**
 * Shared Base-URL + API-key form, used both to add a custom endpoint and to edit
 * a saved one. `saveLabel` distinguishes the two ("Save" vs "Update").
 */
function EndpointForm({
  url,
  setUrl,
  apiKey,
  setApiKey,
  saving,
  error,
  saveLabel,
  onCancel,
  onSave,
}: {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  saving: boolean;
  error: string | null;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-1">
      <label className="text-[11px] uppercase tracking-wide text-white/50">
        Base URL
      </label>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="http://localhost:1234/v1"
        className="w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/40"
      />
      <label className="text-[11px] uppercase tracking-wide text-white/50">
        API key (optional)
      </label>
      <input
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        type="password"
        placeholder="sk-…"
        className="w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/40"
      />
      <p className="px-0.5 text-[10px] leading-relaxed text-white/40">
        Works with any OpenAI-compatible endpoint — and with{" "}
        <span className="text-white/60">Anthropic</span> (
        <code>https://api.anthropic.com</code> + <code>sk-ant-…</code>) and{" "}
        <span className="text-white/60">Google Gemini</span> (
        <code>https://generativelanguage.googleapis.com</code> + your API key)
        directly. The protocol is detected from the URL.
      </p>
      {error ? <div className="text-[11px] text-red-300">{error}</div> : null}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10"
        >
          Cancel
        </button>
        <button
          disabled={saving || !url.trim()}
          onClick={onSave}
          className="rounded-lg bg-white/15 px-3 py-1 text-xs text-white hover:bg-white/25 disabled:opacity-50"
        >
          {saving ? "Validating…" : saveLabel}
        </button>
      </div>
    </div>
  );
}

export function HealthDot({ healthy, size = 8 }: { healthy: boolean; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className={[
        "inline-block shrink-0 rounded-full",
        healthy
          ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]"
          : "bg-red-400/80",
      ].join(" ")}
    />
  );
}

export function useBootstrapRuntime() {
  const bootstrap = useRuntimeStore((s) => s.bootstrap);
  useEffect(() => {
    bootstrap();
  }, [bootstrap]);
}
