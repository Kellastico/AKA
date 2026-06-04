import { useEffect, useState } from "react";
import {
  ArrowsClockwise,
  Cube,
  Plus,
  Plugs,
  PlugsConnected,
} from "@phosphor-icons/react";
import {
  BUILTIN_RUNTIME_NAME,
  builtinEndpoint,
  useRuntimeStore,
} from "./use-runtime-store";
import type { DetectedRuntime, SidecarStatusValue } from "../../lib/tauri/commands";

export function ConnectionPanel({ onDone }: { onDone?: () => void }) {
  const detected = useRuntimeStore((s) => s.detected);
  const detecting = useRuntimeStore((s) => s.detecting);
  const active = useRuntimeStore((s) => s.active);
  const refresh = useRuntimeStore((s) => s.refreshDetection);
  const selectDetected = useRuntimeStore((s) => s.selectDetected);
  const saveManual = useRuntimeStore((s) => s.saveManual);

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

  const noneHealthy = detected.length > 0 && detected.every((d) => !d.healthy);
  const showEmptyHelper = !detecting && (detected.length === 0 || noneHealthy);

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

      <div className="flex flex-col gap-1">
        {detected.map((r) => (
          <RuntimeRow
            key={r.baseUrl}
            runtime={r}
            active={active?.baseUrl === r.baseUrl}
            onSelect={async () => {
              await selectDetected(r);
              onDone?.();
            }}
          />
        ))}
      </div>

      {showEmptyHelper ? (
        <div className="mx-1 rounded-xl border border-white/10 bg-white/5 p-3 text-xs leading-relaxed text-white/70">
          No LLM runtime detected. Start Ollama, LM Studio, or any
          OpenAI-compatible server, then refresh.
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
        <div className="flex flex-col gap-2 px-1">
          <label className="text-[11px] uppercase tracking-wide text-white/50">
            Base URL
          </label>
          <input
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="http://localhost:1234/v1"
            className="w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/40"
          />
          <label className="text-[11px] uppercase tracking-wide text-white/50">
            API key (optional)
          </label>
          <input
            value={manualKey}
            onChange={(e) => setManualKey(e.target.value)}
            type="password"
            placeholder="sk-…"
            className="w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/40"
          />
          {manualError ? (
            <div className="text-[11px] text-red-300">{manualError}</div>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setShowManual(false);
                setManualError(null);
              }}
              className="rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              disabled={saving || !manualUrl.trim()}
              onClick={async () => {
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
              className="rounded-lg bg-white/15 px-3 py-1 text-xs text-white hover:bg-white/25 disabled:opacity-50"
            >
              {saving ? "Validating…" : "Save"}
            </button>
          </div>
        </div>
      )}
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
          {error ?? statusLabel(status)}
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
}: {
  runtime: DetectedRuntime;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={[
        "flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition",
        active ? "bg-white/15" : "hover:bg-white/10",
      ].join(" ")}
    >
      <HealthDot healthy={runtime.healthy} />
      {runtime.healthy ? (
        <PlugsConnected size={14} className="text-white/60" />
      ) : (
        <Plugs size={14} className="text-white/40" />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-xs text-white">{runtime.name}</span>
        <span className="truncate text-[10px] text-white/40">{runtime.baseUrl}</span>
      </div>
    </button>
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
