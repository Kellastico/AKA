import { ArrowRight, Cube, Lock, Robot, Terminal } from "@phosphor-icons/react";
import { useFirstRunStore } from "../../stores/use-first-run-store";

/**
 * Pure marketing copy. Sets the mental model before we ask the user to do
 * anything: AKA is YOUR computer, YOUR models, YOUR agents — we just
 * orchestrate. Then a single big CTA into the real work.
 */
export function WelcomeStep() {
  const next = useFirstRunStore((s) => s.next);

  return (
    <div className="flex flex-col items-center gap-8 py-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <span className="font-display text-[88px] leading-none tracking-tight text-white">
          ÄKÄ
        </span>
        <span className="text-sm text-white/55">
          A local-first workspace for LLM-driven coding
        </span>
      </div>

      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
        <Pillar
          icon={<Cube size={18} weight="duotone" />}
          title="Bring your LLM"
          body="Any OpenAI-compatible endpoint — local or remote."
        />
        <Pillar
          icon={<Robot size={18} weight="duotone" />}
          title="Bring your agent"
          body="Any coding agent — whatever you already use."
        />
        <Pillar
          icon={<Lock size={18} weight="duotone" />}
          title="Stays on your machine"
          body="No cloud, no telemetry. Your code never leaves the device."
        />
      </div>

      <p className="max-w-[440px] text-sm text-white/55">
        We&apos;ll walk through three quick steps to get you running.
        It takes about a minute — you can skip any step and come back to it later.
      </p>

      <button
        onClick={next}
        className="inline-flex items-center gap-2 rounded-full bg-fuchsia-500/90 px-6 py-3 text-sm font-medium text-white shadow-[0_8px_30px_rgba(217,70,239,0.25)] transition-colors hover:bg-fuchsia-400"
      >
        Let&apos;s get started
        <ArrowRight size={14} weight="bold" />
      </button>

      <p className="text-[11px] text-white/30">
        <Terminal size={10} weight="bold" className="-mt-0.5 mr-1 inline" />
        Everything below runs on your machine — no data leaves your device.
      </p>
    </div>
  );
}

function Pillar({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-start gap-1.5 rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-left">
      <div className="flex items-center gap-2 text-fuchsia-300/85">
        {icon}
        <span className="text-[12px] font-semibold uppercase tracking-wide text-white/85">
          {title}
        </span>
      </div>
      <span className="text-[12px] leading-snug text-white/55">{body}</span>
    </div>
  );
}
