import { useMemo, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Gear,
  Lightbulb,
  MagicWand,
  Warning,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import type { AppError } from "../lib/tauri/commands";
import { findFix } from "../lib/error-fixes";
import { Collapse } from "./Collapse";
import { humanizeError } from "../lib/humanize-error";
import { runAutoFix } from "../lib/run-auto-fix";

type Tone = "error" | "warning" | "info";

type Props = {
  error: AppError;
  /** Re-run the exact command that produced this error. */
  onRetry?: () => void;
  /** Open .äkä/config.json in the settings pane. */
  onOpenSettings?: () => void;
  /** Overwrite the project config with defaults. */
  onResetConfig?: () => void;
};

/**
 * Single banner for every backend failure surfaced as `AppError`. Each
 * variant maps to a specific, actionable message — no raw Rust strings.
 *
 * Tone & blocking behaviour is driven by the variant, not the caller:
 * `RuntimeOffline` and `ConfigCorrupted` are blocking (red); `AgentCrash`
 * and `VerifyCommandNotFound` are recoverable errors (red, but the rest of
 * the workspace stays usable); `SandboxViolation` and `SummarizationFailed`
 * are warnings (amber).
 */
export function ErrorBanner({
  error,
  onRetry,
  onOpenSettings,
  onResetConfig,
}: Props) {
  switch (error.kind) {
    case "RuntimeOffline":
      return (
        <Frame tone="error">
          <Body
            title="LLM runtime is not reachable."
            detail="Start Ollama or your local server, then retry."
          />
          {onRetry && <RetryButton onClick={onRetry} />}
        </Frame>
      );

    case "NoAgentsInstalled":
      return (
        <Frame tone="error">
          <Body
            title="No coding agents found."
            detail="Add or install an agent to continue — open the agent picker to register one."
          />
          {error.hints.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px] text-rose-200/80">
              {error.hints.map((h) => (
                <div key={h}>{h}</div>
              ))}
            </div>
          )}
        </Frame>
      );

    case "AgentCrash":
      return (
        <Frame tone="error">
          <Body
            title={`Agent crashed with exit code ${error.exitCode}.`}
            detail="The agent exited before completing the task."
          />
          {error.stderr.trim().length > 0 && (
            <HumanizedAndFix stderr={error.stderr} />
          )}
          {error.stderr.trim().length > 0 && <StderrBlock stderr={error.stderr} />}
          {onRetry && <RetryButton onClick={onRetry} />}
        </Frame>
      );

    case "VerifyCommandNotFound":
      return (
        <Frame tone="error">
          <Body
            title={`Verify command not found: ${error.cmd || "(empty)"}.`}
            detail="Check your .äkä/config.json — the binary couldn't be resolved in PATH."
          />
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/20"
            >
              <Gear size={11} weight="bold" />
              Open settings
            </button>
          )}
        </Frame>
      );

    case "SandboxViolation":
      return (
        <Frame tone="warning">
          <Body
            title={`Blocked: ${error.path} is outside the project sandbox.`}
            detail="Logged as a security event. The agent was prevented from accessing this path."
          />
        </Frame>
      );

    case "ConfigCorrupted":
      return (
        <Frame tone="error">
          <Body
            title="Config file could not be read."
            detail={`Reason: ${error.reason}`}
          />
          {onResetConfig && (
            <button
              type="button"
              onClick={onResetConfig}
              className="inline-flex items-center gap-1.5 self-start rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/20"
            >
              <ArrowClockwise size={11} weight="bold" />
              Reset to defaults
            </button>
          )}
        </Frame>
      );

    case "SummarizationFailed":
      return (
        <Frame tone="warning">
          <Body
            title="Session handoff summary failed."
            detail="Starting fresh — previous session context was not carried forward."
          />
        </Frame>
      );

    case "BackendUnavailable":
      return (
        <Frame tone="error">
          <Body
            title="Backend command unavailable."
            detail={`The Tauri backend returned: ${error.reason}. If you recently updated AKA, restart it (Ctrl+C then \`npm run tauri dev\`) to rebuild the Rust binary with the latest commands.`}
          />
          {onRetry && <RetryButton onClick={onRetry} />}
        </Frame>
      );
  }
}

function Frame({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  const klass =
    tone === "error"
      ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
      : tone === "warning"
        ? "border-amber-400/30 bg-amber-500/10 text-amber-100"
        : "border-sky-400/30 bg-sky-500/10 text-sky-100";
  const Icon =
    tone === "error" ? XCircle : tone === "warning" ? Warning : WarningCircle;
  return (
    <div className={`flex w-full min-w-0 flex-col gap-2 rounded-md border px-3 py-2 text-xs ${klass}`}>
      <div className="flex min-w-0 items-start gap-2">
        <Icon size={14} weight="fill" className="mt-0.5 shrink-0" />
        {/* min-w-0 on the flex child is what actually lets long content (e.g. a
            stderr `<pre>` full of file paths) shrink to the parent's width
            instead of pushing the whole banner past the chat bubble edge. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
      </div>
    </div>
  );
}

function Body({ title, detail }: { title: string; detail?: string }) {
  return (
    <>
      <div className="font-medium">{title}</div>
      {detail && <div className="text-white/70">{detail}</div>}
    </>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 self-start rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/20"
    >
      <ArrowClockwise size={11} weight="bold" />
      Retry
    </button>
  );
}

/**
 * Plain-English translation + Auto-fix button, rendered above the raw stderr
 * block. Hides itself entirely when neither a humanizer rule nor an auto-fix
 * rule matches — we never want to add visual noise above a stack trace if we
 * can't say anything useful about it.
 */
function HumanizedAndFix({ stderr }: { stderr: string }) {
  const explanation = useMemo(() => humanizeError(stderr), [stderr]);
  const fix = useMemo(() => findFix(stderr), [stderr]);
  const [fixing, setFixing] = useState(false);

  if (!explanation && !fix) return null;

  const handleFix = async () => {
    if (!fix) return;
    setFixing(true);
    try {
      await runAutoFix(fix);
    } finally {
      setFixing(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-2">
      {explanation && (
        <div className="flex items-start gap-1.5">
          <Lightbulb
            size={12}
            weight="fill"
            className="mt-0.5 shrink-0 text-amber-300/80"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="text-[12px] font-medium text-white/90">
              {explanation.title}
            </div>
            <div className="text-[11px] text-white/60">{explanation.hint}</div>
          </div>
        </div>
      )}
      {fix && (
        <button
          type="button"
          onClick={() => void handleFix()}
          disabled={fixing}
          className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md border border-emerald-400/35 bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-100 transition-colors hover:border-emerald-300/55 hover:bg-emerald-500/22 disabled:opacity-50"
        >
          <MagicWand size={11} weight="fill" />
          {fixing ? "Running fix…" : `Auto-fix · ${fix.title}`}
        </button>
      )}
    </div>
  );
}

function StderrBlock({ stderr }: { stderr: string }) {
  const [open, setOpen] = useState(true);
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 self-start text-[11px] text-white/60 hover:text-white"
      >
        <Caret size={11} weight="bold" />
        stderr (last lines)
      </button>
      <Collapse open={open}>
        {/* break-all (not break-words) so long unbreakable strings — file
            paths, URLs, base64 blobs — wrap at any character. break-words
            alone only splits at word boundaries, which fails for content
            like "/Library/Developer/CommandLineTools/Library/Frameworks/…"
            where there are no word boundaries. */}
        <pre className="max-h-40 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-all rounded border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-white/80">
          {stderr}
        </pre>
      </Collapse>
    </div>
  );
}
