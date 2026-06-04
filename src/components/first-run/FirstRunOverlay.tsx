import { CaretLeft, X } from "@phosphor-icons/react";
import {
  useFirstRunStore,
  type FirstRunStep,
} from "../../stores/use-first-run-store";

// The four user-visible steps. "done" is a terminal pseudo-step that just
// triggers complete() — it's never rendered, so it's not part of this list.
const VISIBLE_STEPS: FirstRunStep[] = ["welcome", "runtime", "agent", "project"];
import { WelcomeStep } from "./WelcomeStep";
import { RuntimeStep } from "./RuntimeStep";
import { AgentStep } from "./AgentStep";
import { ProjectStep } from "./ProjectStep";

/**
 * First-run setup wizard. Full-screen overlay that walks new users through
 * the four things that need to be in place before they can send a prompt:
 * a connected LLM, a selected agent, and a project folder.
 *
 * Mounted unconditionally in AppShell; renders nothing when setup is done
 * or dismissed for the session. Steps live in sibling files so this one
 * stays a router + chrome layer.
 */
export function FirstRunOverlay() {
  const completed = useFirstRunStore((s) => s.completed);
  const loading = useFirstRunStore((s) => s.loading);
  const dismissed = useFirstRunStore((s) => s.dismissedThisSession);
  const currentStep = useFirstRunStore((s) => s.currentStep);
  const dismiss = useFirstRunStore((s) => s.dismiss);

  // Never render until init() has read disk — prevents a frame-flash where
  // the overlay shows for ~50ms during app boot for existing users.
  if (loading || completed || dismissed) return null;

  const stepIndex = VISIBLE_STEPS.indexOf(currentStep);

  return (
    <div
      data-testid="first-run-overlay"
      className="fixed inset-0 z-[120] flex flex-col bg-[#0d0019]/95 backdrop-blur-xl text-white"
    >
      {/* Header: step progress + skip-for-now */}
      <header className="flex shrink-0 items-center justify-between gap-4 px-8 py-5">
        <div className="flex items-center gap-2">
          {VISIBLE_STEPS.map((step, i) => (
            <StepDot
              key={step}
              active={i === stepIndex}
              completed={i < stepIndex}
              label={STEP_LABELS[step]}
            />
          ))}
        </div>
        <button
          onClick={dismiss}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-3 py-1.5 text-[11px] text-white/55 transition-colors hover:border-white/25 hover:text-white"
          aria-label="Skip setup for now"
        >
          <X size={11} />
          Skip for now
        </button>
      </header>

      {/* Active step */}
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-8">
        <div className="w-full max-w-[640px]">
          {currentStep === "welcome" && <WelcomeStep />}
          {currentStep === "runtime" && <RuntimeStep />}
          {currentStep === "agent" && <AgentStep />}
          {currentStep === "project" && <ProjectStep />}
        </div>
      </main>

      {/* Back button — bottom-left, doesn't fight the per-step primary CTA. */}
      <footer className="flex shrink-0 items-center justify-between gap-4 px-8 py-5">
        <BackButton currentStep={currentStep} />
        <div className="text-[11px] text-white/35">
          Step {stepIndex + 1} of {VISIBLE_STEPS.length}
        </div>
      </footer>
    </div>
  );
}

const STEP_LABELS: Record<FirstRunStep, string> = {
  welcome: "Welcome",
  runtime: "LLM",
  agent: "Agent",
  project: "Project",
  done: "Done",
};

function StepDot({
  active,
  completed,
  label,
}: {
  active: boolean;
  completed: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={[
          "h-1.5 w-1.5 rounded-full transition-colors",
          active
            ? "bg-fuchsia-400"
            : completed
              ? "bg-emerald-400/80"
              : "bg-white/15",
        ].join(" ")}
      />
      <span
        className={[
          "text-[10px] uppercase tracking-wide transition-colors",
          active
            ? "text-white"
            : completed
              ? "text-white/55"
              : "text-white/30",
        ].join(" ")}
      >
        {label}
      </span>
    </div>
  );
}

function BackButton({ currentStep }: { currentStep: FirstRunStep }) {
  const prev = useFirstRunStore((s) => s.prev);
  if (currentStep === "welcome") return <div />; // keep flex balance
  return (
    <button
      onClick={prev}
      className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-3 py-1.5 text-[11px] text-white/65 transition-colors hover:border-white/25 hover:text-white"
    >
      <CaretLeft size={11} weight="bold" />
      Back
    </button>
  );
}
