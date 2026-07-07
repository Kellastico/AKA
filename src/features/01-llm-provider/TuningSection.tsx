import { Thermometer, Funnel } from "@phosphor-icons/react";
import { useProjectConfigStore } from "../../stores/use-project-config-store";

/**
 * Sampling-control sliders (temperature + top-p) for the active project's
 * runtime block. Lives inside the Runtime modal's Advanced Settings accordion.
 *
 * These map to `runtime.temperature` / `runtime.top_p` in `.äkä/config.json`.
 * A `null` value means "unset" — the backend then applies AKA's accuracy-leaning
 * defaults (see llm.rs: DEFAULT_TEMPERATURE / DEFAULT_TOP_P). We mirror those
 * here so the "Auto" state shows the real number the model will receive. The
 * config is re-read from disk on every call, so edits apply to the next run
 * without a restart.
 *
 * Written to be legible to beginners (plain-language endpoint labels + a
 * one-line "what this does") and precise for advanced users (exact numeric
 * value, and a Reset that restores AKA's default rather than a made-up one).
 */

// Keep these in lockstep with src-tauri/src/commands/llm.rs.
const DEFAULT_TEMPERATURE = 0.15;
const DEFAULT_TOP_P = 0.9;

export function TuningSection() {
  const projectPath = useProjectConfigStore((s) => s.projectPath);
  const temperature = useProjectConfigStore(
    (s) => s.config?.runtime.temperature ?? null,
  );
  const topP = useProjectConfigStore((s) => s.config?.runtime.top_p ?? null);
  const setRuntimeTuning = useProjectConfigStore((s) => s.setRuntimeTuning);

  if (!projectPath) {
    return (
      <p className="px-0.5 text-[10px] leading-relaxed text-white/40">
        Open a project to tune its sampling. Until then AKA uses its
        accuracy-leaning defaults (temperature {DEFAULT_TEMPERATURE} · top-p{" "}
        {DEFAULT_TOP_P}).
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-1">
      <TuningSlider
        icon={<Thermometer size={12} className="text-white/50" />}
        label="Temperature"
        value={temperature}
        autoValue={DEFAULT_TEMPERATURE}
        min={0}
        max={2}
        step={0.05}
        lowLabel="Precise"
        highLabel="Creative"
        description="How adventurous the model is. Lower keeps answers focused and repeatable — best for coding. Higher adds variety and surprise."
        onChange={(v) => void setRuntimeTuning({ temperature: v })}
        onReset={() => void setRuntimeTuning({ temperature: null })}
      />

      <div className="h-px bg-white/10" />

      <TuningSlider
        icon={<Funnel size={12} className="text-white/50" />}
        label="Top-P"
        value={topP}
        autoValue={DEFAULT_TOP_P}
        min={0}
        max={1}
        step={0.05}
        lowLabel="Narrow"
        highLabel="Wide"
        description="How many word choices stay in play (nucleus sampling). Lower trims to only the most likely tokens; higher lets rarer words through. Most people leave this on Auto."
        onChange={(v) => void setRuntimeTuning({ top_p: v })}
        onReset={() => void setRuntimeTuning({ top_p: null })}
      />
    </div>
  );
}

function TuningSlider({
  icon,
  label,
  value,
  autoValue,
  min,
  max,
  step,
  lowLabel,
  highLabel,
  description,
  onChange,
  onReset,
}: {
  icon: React.ReactNode;
  label: string;
  /** null = unset → AKA applies `autoValue`. */
  value: number | null;
  autoValue: number;
  min: number;
  max: number;
  step: number;
  lowLabel: string;
  highLabel: string;
  description: string;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const isAuto = value === null;
  // When unset, park the thumb at the default so the track reflects the value
  // the model will actually receive — but dim it to signal "not yet overridden".
  const sliderValue = isAuto ? autoValue : value;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
          {label}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {isAuto ? (
            <span
              className="rounded bg-white/10 px-1.5 py-px text-[10px] font-medium text-white/50"
              title={`Unset — AKA uses its default of ${autoValue}`}
            >
              Auto · {autoValue}
            </span>
          ) : (
            <>
              <span className="font-mono text-[11px] tabular-nums text-white/80">
                {sliderValue.toFixed(2)}
              </span>
              <button
                onClick={onReset}
                title={`Reset to Auto (${autoValue})`}
                className="rounded px-1 py-px text-[10px] text-white/40 transition hover:bg-white/10 hover:text-white/80"
              >
                Reset
              </button>
            </>
          )}
        </span>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={sliderValue}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        style={{
          // Drives the amber rail-fill in styles.css (.aka-slider track).
          ["--pct" as string]: `${((sliderValue - min) / (max - min)) * 100}%`,
        }}
        className={[
          "aka-slider transition-opacity",
          isAuto ? "opacity-60 hover:opacity-100" : "opacity-100",
        ].join(" ")}
      />

      <div className="flex justify-between text-[9px] uppercase tracking-wide text-white/35">
        <span>
          {lowLabel} · {min}
        </span>
        <span>
          {highLabel} · {max}
        </span>
      </div>

      <p className="text-[10px] leading-relaxed text-white/40">{description}</p>
    </div>
  );
}
