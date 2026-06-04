import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  ArrowSquareOut,
  Check,
  CircleNotch,
  Cube,
  Warning,
} from "@phosphor-icons/react";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { useFirstRunStore } from "../../stores/use-first-run-store";

/**
 * Auto-scans localhost for known LLM runtimes (Ollama, LM Studio, MLX). The
 * happy path is one click: detected runtime → connect → first model auto-
 * selected. Falls back to a manual URL input + "install Ollama" link when
 * nothing is running.
 */
export function RuntimeStep() {
  const next = useFirstRunStore((s) => s.next);

  const detected = useRuntimeStore((s) => s.detected);
  const detecting = useRuntimeStore((s) => s.detecting);
  const active = useRuntimeStore((s) => s.active);
  const healthy = useRuntimeStore((s) => s.healthy);
  const models = useRuntimeStore((s) => s.models);
  const loadingModels = useRuntimeStore((s) => s.loadingModels);
  const modelsError = useRuntimeStore((s) => s.modelsError);
  const selectedModelId = useRuntimeStore((s) => s.selectedModelId);

  const refreshDetection = useRuntimeStore((s) => s.refreshDetection);
  const selectDetected = useRuntimeStore((s) => s.selectDetected);
  const saveManual = useRuntimeStore((s) => s.saveManual);
  const selectModel = useRuntimeStore((s) => s.selectModel);

  const [manualUrl, setManualUrl] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  // Re-scan whenever the user lands on this step — runtimes might've started
  // between launch and now (user opened AKA, then started Ollama).
  useEffect(() => {
    void refreshDetection();
  }, [refreshDetection]);

  const submitManual = async () => {
    const trimmed = manualUrl.trim();
    if (!trimmed) return;
    setManualBusy(true);
    setManualError(null);
    const r = await saveManual(trimmed, null);
    setManualBusy(false);
    if (!r.ok) setManualError(r.error ?? "Couldn't connect");
  };

  const canContinue = !!active && healthy && !!selectedModelId;

  return (
    <div className="flex flex-col gap-6">
      <Header
        title="Connect to your LLM"
        subtitle="AKA scans localhost for known runtimes. Pick one we found, or point us at a custom URL."
      />

      {/* Detection results */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Detected on this machine</SectionLabel>
          <button
            onClick={() => void refreshDetection()}
            disabled={detecting}
            className="inline-flex items-center gap-1 text-[11px] text-white/55 hover:text-white disabled:opacity-50"
          >
            <ArrowClockwise
              size={11}
              className={detecting ? "animate-spin" : ""}
            />
            {detecting ? "Scanning…" : "Rescan"}
          </button>
        </div>

        {detected.length === 0 && !detecting && (
          <EmptyDetected />
        )}

        {detected.map((r) => {
          const isActive = active?.baseUrl === r.baseUrl;
          return (
            <button
              key={r.baseUrl}
              onClick={() => void selectDetected(r)}
              className={[
                "flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                isActive
                  ? "border-emerald-400/40 bg-emerald-400/8"
                  : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]",
              ].join(" ")}
            >
              <div className="flex items-center gap-2.5">
                <Cube size={18} weight="duotone" className="text-fuchsia-300/80" />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{r.name}</span>
                  <span className="font-mono text-[11px] text-white/45">
                    {r.baseUrl}
                  </span>
                </div>
              </div>
              {isActive && (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                  <Check size={11} weight="bold" />
                  Connected
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Manual URL fallback */}
      <details className="rounded-2xl border border-white/8 bg-white/[0.02] px-4 py-3 [&_summary::-webkit-details-marker]:hidden">
        <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-white/45 hover:text-white/65">
          Or enter a custom URL
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submitManual()}
              placeholder="http://localhost:11434"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-white/85 outline-none focus:border-white/25"
            />
            <button
              onClick={() => void submitManual()}
              disabled={manualBusy || manualUrl.trim().length === 0}
              className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-[12px] text-white/85 hover:bg-white/15 disabled:opacity-50"
            >
              {manualBusy ? "Testing…" : "Connect"}
            </button>
          </div>
          {manualError && (
            <p className="text-[11px] text-red-300/90">{manualError}</p>
          )}
        </div>
      </details>

      {/* Model picker — only once a runtime is healthy */}
      {active && healthy && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Pick a model</SectionLabel>
          {loadingModels ? (
            <div className="flex items-center gap-2 text-[12px] text-white/55">
              <CircleNotch size={12} className="animate-spin" />
              Loading models from {active.baseUrl}…
            </div>
          ) : modelsError ? (
            <p className="text-[12px] text-red-300/90">{modelsError}</p>
          ) : models.length === 0 ? (
            <p className="text-[12px] text-white/55">
              Runtime returned no models. Pull one with{" "}
              <code className="text-white/75">ollama pull qwen2.5-coder:7b</code>{" "}
              (or your runtime&apos;s equivalent) and rescan.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {models.map((m) => (
                <button
                  key={m}
                  onClick={() => void selectModel(m)}
                  className={[
                    "rounded-full border px-3 py-1.5 text-[12px] font-mono transition-colors",
                    m === selectedModelId
                      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
                      : "border-white/10 bg-white/5 text-white/70 hover:border-white/25 hover:text-white",
                  ].join(" ")}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Continue */}
      <div className="flex items-center justify-end pt-2">
        <button
          onClick={next}
          disabled={!canContinue}
          className="inline-flex items-center gap-2 rounded-full bg-fuchsia-500/90 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-fuchsia-400 disabled:bg-white/10 disabled:text-white/35"
        >
          Continue
          <ArrowRight size={13} weight="bold" />
        </button>
      </div>
    </div>
  );
}

function EmptyDetected() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-500/[0.06] px-4 py-3 text-[12px] text-amber-100">
      <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-300" />
      <div className="flex flex-col gap-1">
        <span className="font-medium">No LLM runtime detected locally.</span>
        <span className="text-amber-100/70">
          Install Ollama (recommended for beginners) or LM Studio, run it,
          then click Rescan above.
        </span>
        <button
          onClick={() => void openExternalUrl("https://ollama.com/download")}
          className="mt-1 inline-flex items-center gap-1 self-start text-[11px] text-amber-200 underline hover:text-amber-100"
        >
          Get Ollama
          <ArrowSquareOut size={10} />
        </button>
      </div>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="text-sm text-white/55">{subtitle}</p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
      {children}
    </span>
  );
}
