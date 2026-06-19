import { useState } from "react";
import {
  Gear,
  CheckCircle,
  CaretDown,
  Brain,
  NotePencil,
  Eye,
  TerminalWindow,
  MagnifyingGlass,
  Copy,
  Check,
  FileText,
  Warning,
  type Icon,
} from "@phosphor-icons/react";
import type { Message, ToolKind } from "../../stores/use-messages-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { Collapse } from "../Collapse";
import { Markdown } from "./Markdown";
import { fmtElapsed } from "./MessageItem";
import { useTicker, fmtClock, approxTokens } from "./timeline-util";
import { activeSummary, baseName, clampWords, DiffStat, rollupFiles } from "./tool-summary";

/* ── tool kind → icon + accent (matches the rest of the chat surface) ── */
const TOOL_ICONS: Record<ToolKind, Icon> = {
  write: NotePencil,
  read: Eye,
  run: TerminalWindow,
  search: MagnifyingGlass,
};
const TOOL_ACCENT: Record<ToolKind, { dot: string; text: string }> = {
  read: { dot: "bg-sky-400", text: "text-sky-200" },
  write: { dot: "bg-amber-400", text: "text-amber-200" },
  run: { dot: "bg-emerald-400", text: "text-emerald-200" },
  search: { dot: "bg-fuchsia-400", text: "text-fuchsia-200" },
};

const FROST =
  "border border-white/20 bg-white/12 backdrop-blur-xl " +
  "shadow-[0_4px_20px_rgba(255,255,255,0.04),inset_0_1px_0_rgba(255,255,255,0.15)]";

/* ── timeline node view-model derived from the run's messages ── */
type RunNode = { type: "reasoning" | "tool"; msg: Message; key: string };

const isStreaming = (m: Message) =>
  m.thinkingStartedAt !== undefined && m.thinkingEndedAt === undefined;
const isRunningTool = (m: Message) => m.toolStatus === "running";

/** First non-empty line of a reasoning body, clamped for the collapsed snippet. */
function snippet(text: string | undefined, words = 14): string {
  const first = (text ?? "").trim().split("\n").find((l) => l.trim()) ?? "";
  return clampWords(first, words);
}
/** Last few lines of a streaming reasoning body — the live "thinking" preview. */
function tailLines(text: string | undefined, n = 3): string {
  const lines = (text ?? "").trim().split("\n").filter((l) => l.trim());
  return lines.slice(-n).join("\n");
}

/**
 * One agent run, rendered as a single ordered timeline: reasoning segments and
 * tool calls interleave on a vertical rail in the exact order they occurred,
 * then the final answer + a roll-up footer. Reasoning and tools are no longer
 * split into two disconnected accordions.
 *
 * `messages` is the run group: the interleaved reasoning + tool messages,
 * optionally followed by the assistant answer (which may also carry the final
 * reasoning segment as its `thinkingContent`).
 */
export function RunTimeline({ messages }: { messages: Message[] }) {
  // The trailing assistant message (if any) is the run's final answer.
  const answer = [...messages].reverse().find((m) => m.role === "assistant");
  const activity = messages.filter((m) => m !== answer);

  // Interleaved nodes, in order. The answer's own thinking is the concluding
  // reasoning node (keeps legacy runs — reasoning-on-assistant — rendering too).
  const nodes: RunNode[] = activity.map((m) => ({
    type: m.role === "tool" ? "tool" : "reasoning",
    msg: m,
    key: m.id,
  }));
  if (answer?.thinkingContent) {
    nodes.push({ type: "reasoning", msg: answer, key: `${answer.id}-think` });
  }

  const toolMsgs = activity.filter((m) => m.role === "tool");
  const anyToolRunning = toolMsgs.some(isRunningTool);
  const anyReasoningStreaming = nodes.some(
    (n) => n.type === "reasoning" && isStreaming(n.msg),
  );
  const answerPending =
    !!answer && answer.pendingSince !== undefined && answer.content.length === 0;
  const anyLive = anyToolRunning || anyReasoningStreaming;
  const isRunning = anyLive || answerPending;
  const status: "running" | "error" | "done" = isRunning
    ? "running"
    : answer?.error
      ? "error"
      : "done";

  // Whole-run collapse: live runs open so progress is visible; settled history
  // mounts collapsed (like the old Reasoning accordion) to keep the thread calm.
  const [open, setOpen] = useState(isRunning);

  useTicker(isRunning);
  const now = Date.now();

  // Run wall-clock — min start → max end across all nodes (ticks while live).
  const starts: number[] = [];
  const ends: number[] = [];
  for (const n of nodes) {
    if (n.type === "reasoning") {
      if (n.msg.thinkingStartedAt !== undefined) starts.push(n.msg.thinkingStartedAt);
      if (n.msg.thinkingEndedAt !== undefined) ends.push(n.msg.thinkingEndedAt);
    } else {
      if (n.msg.toolStartedAt !== undefined) starts.push(n.msg.toolStartedAt);
      if (n.msg.toolStartedAt !== undefined && n.msg.toolElapsedMs !== undefined)
        ends.push(n.msg.toolStartedAt + n.msg.toolElapsedMs);
    }
  }
  const startAt = starts.length ? Math.min(...starts) : undefined;
  const lastEnd = ends.length ? Math.max(...ends) : undefined;
  const totalMs =
    startAt === undefined
      ? 0
      : Math.max(0, (isRunning ? now : lastEnd ?? now) - startAt);

  // ~tokens from chars/4 (the heuristic AKA already uses app-wide).
  const chars =
    nodes.reduce((s, n) => s + (n.msg.thinkingContent?.length ?? 0), 0) +
    toolMsgs.reduce(
      (s, m) => s + (m.toolPreview?.length ?? 0) + (m.toolInput?.length ?? 0),
      0,
    ) +
    (answer?.content.length ?? 0);

  const files = rollupFiles(toolMsgs);
  const added = toolMsgs.reduce((s, m) => s + (m.linesAdded ?? 0), 0);
  const removed = toolMsgs.reduce((s, m) => s + (m.linesRemoved ?? 0), 0);

  // Header summary of the current action while running (glanceable, no expand).
  const runningTool = [...toolMsgs].reverse().find(isRunningTool);
  const liveLabel = runningTool
    ? clampWords(activeSummary(runningTool))
    : anyReasoningStreaming
      ? "Thinking"
      : "Working";

  return (
    <div className="flex w-full min-w-0 flex-col">
      {/* ── run header — collapses the whole timeline ── */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-ink/45 hover:bg-ink/5 hover:text-ink/70"
      >
        <Gear size={12} className={isRunning ? "animate-spin" : ""} />
        <span className="max-w-[16rem] truncate">{isRunning ? liveLabel : "Worked"}</span>
        {isRunning ? (
          <span className="ml-0.5 inline-flex gap-0.5">
            <span className="h-1 w-1 animate-pulse rounded-full bg-ink/40 [animation-delay:0ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-ink/40 [animation-delay:150ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-ink/40 [animation-delay:300ms]" />
          </span>
        ) : null}
        {startAt !== undefined && (
          <span className="tabular-nums text-ink/35">· {fmtClock(totalMs)}</span>
        )}
        {toolMsgs.length > 0 && (
          <span className="tabular-nums text-ink/30">
            · {toolMsgs.length} {toolMsgs.length === 1 ? "step" : "steps"}
          </span>
        )}
        {files.length > 0 && (
          <span className="inline-flex items-center gap-1 text-ink/40">
            <span className="text-ink/25">·</span>
            <FileText size={10} />
            <span className="tabular-nums">{files.length}</span>
          </span>
        )}
        {(added > 0 || removed > 0) && <DiffStat added={added} removed={removed} compact />}
        <CaretDown
          size={10}
          className={["ml-auto transition-transform", open ? "rotate-180" : ""].join(" ")}
        />
      </button>

      {/* ── interleaved timeline rail ── */}
      <Collapse open={open}>
        <div className={["relative mt-1 flex flex-col gap-1.5 rounded-xl px-3 py-2.5", FROST].join(" ")}>
          {/* vertical rail line behind the node markers */}
          <span
            className="pointer-events-none absolute bottom-3 left-[16px] top-3 w-px bg-white/12"
            aria-hidden
          />
          {nodes.map((n) =>
            n.type === "reasoning" ? (
              <ReasoningNode key={n.key} msg={n.msg} />
            ) : (
              <ToolNode key={n.key} msg={n.msg} />
            ),
          )}
          {/* live tail when the model is working between visible nodes */}
          {isRunning && !anyLive && (
            <div className="relative flex items-center gap-2.5 pl-1">
              <span className="relative z-10 flex h-3 w-3 items-center justify-center">
                <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
              </span>
              <span className="animate-pulse text-[11px] text-ink/55">Working…</span>
            </div>
          )}
        </div>
      </Collapse>

      {/* ── final answer + footer + copy ── */}
      {answer && (answer.content.length > 0 || status === "error") && (
        <AnswerBlock answer={answer} totalMs={totalMs} chars={chars} status={status} startAt={startAt} />
      )}
    </div>
  );
}

/* ── reasoning node ───────────────────────────────────────────────────── */
function ReasoningNode({ msg }: { msg: Message }) {
  const streaming = isStreaming(msg);
  const [open, setOpen] = useState(false);
  useTicker(streaming);

  const start = msg.thinkingStartedAt;
  const end = msg.thinkingEndedAt;
  const elapsed = start !== undefined ? (end ?? Date.now()) - start : undefined;

  return (
    <div className="relative flex gap-2.5 pl-1">
      <span className="relative z-10 mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
        <span
          className={[
            "h-2 w-2 rounded-full",
            streaming ? "animate-pulse bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.5)]" : "bg-ink/30",
          ].join(" ")}
        />
      </span>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-ink/55 hover:bg-ink/5 hover:text-ink/75"
        >
          <Brain
            size={12}
            weight={streaming && !open ? "fill" : "regular"}
            className={streaming && !open ? "animate-icon-pulse text-indigo-300" : "text-ink/45"}
          />
          <span className="min-w-0 flex-1 truncate">
            {streaming ? "Thinking" : snippet(msg.thinkingContent) || "Reasoning"}
          </span>
          {elapsed !== undefined && (
            <span className="shrink-0 tabular-nums text-ink/30">{fmtClock(elapsed)}</span>
          )}
          <CaretDown
            size={9}
            className={["shrink-0 transition-transform", open ? "rotate-180" : ""].join(" ")}
          />
        </button>

        {/* live preview (last 1–3 lines) while streaming and collapsed */}
        {streaming && !open && tailLines(msg.thinkingContent) && (
          <p className="mt-0.5 whitespace-pre-wrap px-1 text-[11px] leading-snug text-ink/45 [overflow-wrap:anywhere]">
            {tailLines(msg.thinkingContent)}
          </p>
        )}

        <Collapse open={open}>
          <div className="mt-1 whitespace-pre-wrap rounded-lg border border-white/10 bg-ink/5 px-2.5 py-2 text-[11px] leading-relaxed text-ink/75 [overflow-wrap:anywhere]">
            {msg.thinkingContent}
          </div>
        </Collapse>
      </div>
    </div>
  );
}

/* ── tool node ────────────────────────────────────────────────────────── */
function ToolNode({ msg }: { msg: Message }) {
  const openDiffForFile = useWorkspaceStore((s) => s.openDiffForFile);
  const [open, setOpen] = useState(false);
  const running = msg.toolStatus === "running";
  const failed = msg.toolStatus === "failed";
  useTicker(running);

  if (!msg.toolKind) return null;
  const accent = TOOL_ACCENT[msg.toolKind];
  const Icon = TOOL_ICONS[msg.toolKind];
  const label = msg.toolName ?? msg.toolKind;

  const elapsed =
    msg.toolElapsedMs !== undefined
      ? msg.toolElapsedMs
      : running && msg.toolStartedAt !== undefined
        ? Date.now() - msg.toolStartedAt
        : undefined;

  const hasDiff = msg.linesAdded !== undefined || msg.linesRemoved !== undefined;
  const isDiffable = !!msg.toolPath && hasDiff;

  return (
    <div className="relative flex gap-2.5 pl-1">
      <span className="relative z-10 mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
        {running ? (
          <span className={["h-2 w-2 animate-pulse rounded-full", accent.dot].join(" ")} />
        ) : failed ? (
          <Warning size={12} weight="fill" className="text-amber-400" />
        ) : (
          <CheckCircle size={12} weight="fill" className={accent.text} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11.5px] hover:bg-ink/5"
        >
          <Icon size={12} className={failed ? "text-amber-200" : accent.text} />
          <span className={["font-mono font-medium", failed ? "text-amber-100" : accent.text].join(" ")}>
            {label}
          </span>
          {msg.toolPath && (
            <span
              role="button"
              tabIndex={isDiffable ? 0 : -1}
              onClick={(e) => {
                if (!isDiffable) return;
                e.stopPropagation();
                openDiffForFile(msg.toolPath!);
              }}
              onKeyDown={(e) => {
                if (!isDiffable) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  openDiffForFile(msg.toolPath!);
                }
              }}
              className={[
                "truncate rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[10px] text-ink/65",
                isDiffable ? "hover:bg-ink/10 hover:text-ink/90" : "",
              ].join(" ")}
              title={msg.toolPath}
            >
              {baseName(msg.toolPath)}
            </span>
          )}
          {running ? (
            <span className="truncate text-[11px] text-ink/45">using {label}…</span>
          ) : (
            hasDiff && <DiffStat added={msg.linesAdded} removed={msg.linesRemoved} compact />
          )}
          {elapsed !== undefined && (
            <span className="ml-auto shrink-0 tabular-nums text-[10px] text-ink/30">
              {fmtElapsed(elapsed)}
            </span>
          )}
          <CaretDown
            size={9}
            className={["shrink-0 transition-transform", open ? "rotate-180" : ""].join(" ")}
          />
        </button>

        {/* running preview line — the glanceable active summary */}
        {running && (
          <p className="mt-0.5 truncate px-1 text-[11px] text-ink/45">
            {activeSummary(msg)}
          </p>
        )}

        <Collapse open={open}>
          <div className="mt-1 flex flex-col gap-1 rounded-lg border border-white/10 bg-ink/5 px-2.5 py-2 text-[11px]">
            {msg.toolInput && (
              <div className="min-w-0">
                <div className="mb-0.5 text-[9px] uppercase tracking-wider text-ink/35">Input</div>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] text-ink/70 [overflow-wrap:anywhere]">
                  {msg.toolInput}
                </pre>
              </div>
            )}
            {msg.toolPreview && (
              <div className="min-w-0">
                <div className="mb-0.5 text-[9px] uppercase tracking-wider text-ink/35">Output</div>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] text-ink/70 [overflow-wrap:anywhere]">
                  {msg.toolPreview}
                </pre>
              </div>
            )}
            {!msg.toolInput && !msg.toolPreview && (
              <span className="text-ink/40">No additional detail.</span>
            )}
          </div>
        </Collapse>
      </div>
    </div>
  );
}

/* ── answer + footer + copy ───────────────────────────────────────────── */
function AnswerBlock({
  answer,
  totalMs,
  chars,
  status,
  startAt,
}: {
  answer: Message;
  totalMs: number;
  chars: number;
  status: "running" | "error" | "done";
  startAt?: number;
}) {
  const statusText = status === "running" ? "running" : status === "error" ? "error" : "done";
  const statusColor =
    status === "error" ? "text-amber-300" : status === "running" ? "text-indigo-300" : "text-emerald-300/90";

  return (
    <div className="group mt-1 flex w-full min-w-0 flex-col items-start gap-1.5">
      {answer.content.length > 0 && (
        <div className="w-full min-w-0 max-w-full overflow-hidden break-words font-mono text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere] [word-break:break-word]">
          <Markdown>{answer.content}</Markdown>
        </div>
      )}

      {/* run roll-up — total · ~tokens · status (durations are text, not colour) */}
      <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-ink/40">
        {startAt !== undefined && <span className="tabular-nums">{fmtClock(totalMs)}</span>}
        {startAt !== undefined && <span className="text-ink/25">·</span>}
        <span className="tabular-nums">{approxTokens(chars)} tokens</span>
        <span className="text-ink/25">·</span>
        <span className={statusColor}>{statusText}</span>
      </div>

      {/* hover-persistent action row */}
      {answer.content.length > 0 && (
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={answer.content} />
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (no secure context) — leave the button unchanged.
    }
  };
  return (
    <button
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy reply"}
      className={[
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]",
        "border border-white/10 text-ink/55 hover:bg-ink/5 hover:text-ink/80",
        copied ? "!opacity-100 text-emerald-300" : "",
      ].join(" ")}
    >
      {copied ? <Check size={11} weight="bold" /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
