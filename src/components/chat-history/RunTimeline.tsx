import { useState } from "react";
import {
  CheckCircle,
  CaretDown,
  Brain,
  NotePencil,
  Eye,
  TerminalWindow,
  MagnifyingGlass,
  Warning,
  type Icon,
} from "@phosphor-icons/react";
import type { Message, ToolKind } from "../../stores/use-messages-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { Collapse } from "../Collapse";
import { ErrorBanner } from "../ErrorBanner";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { fmtElapsed } from "./MessageItem";
import { useTicker, fmtClock, fmtTokenCount } from "./timeline-util";
import { baseName, DiffStat, DiffView, toolIOLabels } from "./tool-summary";
import { toChatMessages, estimateTokens } from "../../lib/token-estimate";

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

/* ── timeline node view-model derived from the run's messages ── */
export type RunNode = { type: "reasoning" | "tool"; msg: Message; key: string };

const isStreaming = (m: Message) =>
  m.thinkingStartedAt !== undefined && m.thinkingEndedAt === undefined;
const isRunningTool = (m: Message) => m.toolStatus === "running";

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
export function RunTimeline({
  messages,
  live,
}: {
  messages: Message[];
  /**
   * The session's run-in-flight flag, passed only for the *latest* run. It's
   * authoritative for whether this run is still going — so the footer status
   * stays in lockstep with the composer's stop button instead of declaring
   * "Done" the moment the messages momentarily settle (while the agent process
   * is still alive). `undefined` on historical runs → fall back to the
   * message-derived liveness below.
   */
  live?: boolean;
}) {
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
  // The session flag wins when provided (latest run) so "Done" can't show while
  // the composer's stop button is still up; historical runs fall back to their
  // own settled message state.
  const isRunning = live ?? (anyLive || answerPending);
  const status: "running" | "error" | "done" = isRunning
    ? "running"
    : answer?.error
      ? "error"
      : "done";

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
  // Start the run clock at dispatch (the answer placeholder's pendingSince),
  // not at the first streamed token — so the total folds in the LLM's
  // boot/load + time-to-first-token. On a local model that cold-load is often
  // the bulk of the wait, and including it is how the user sees how fast or
  // slow their LLM actually is.
  if (answer?.pendingSince !== undefined) starts.push(answer.pendingSince);
  const startAt = starts.length ? Math.min(...starts) : undefined;
  const lastEnd = ends.length ? Math.max(...ends) : undefined;
  const totalMs =
    startAt === undefined
      ? 0
      : Math.max(0, (isRunning ? now : lastEnd ?? now) - startAt);

  // Tokens this run contributed to the conversation context. Counted through
  // the SAME mapping + estimator the context-window meter uses (see
  // lib/token-estimate), so a run's footer can never exceed the session total —
  // reasoning/tool I/O is generated then dropped, so it isn't counted here.
  const tokens = estimateTokens(toChatMessages(messages));

  // Drives the final-answer divider: only draw the separating border when
  // there's reasoning/tool activity above it to separate from.
  const hasActivity = nodes.length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col">
      {/* ── interleaved timeline — flat in the thread, no container ── */}
      <div className="relative flex flex-col gap-1.5">
        {/* vertical rail line threaded behind the node markers */}
        <span
          className="pointer-events-none absolute bottom-2 left-[10px] top-2 w-px bg-white/12"
          aria-hidden
        />
        {/* Every reasoning + tool row renders inline, in the exact order it
            occurred — reasoning stays in chronological linestep with the tool
            calls (no grouping/collapsing into a separate accordion). */}
        {nodes.map((node) =>
          node.type === "reasoning" ? (
            <ReasoningNode key={node.key} msg={node.msg} />
          ) : (
            <ToolNode key={node.key} msg={node.msg} />
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

      {/* ── final answer + footer + copy ── */}
      {answer && (answer.content.length > 0 || status === "error") && (
        <AnswerBlock answer={answer} totalMs={totalMs} tokens={tokens} status={status} startAt={startAt} hasActivity={hasActivity} />
      )}
    </div>
  );
}

/* ── reasoning node — thinking shown out loud, inline (no accordion) ───── */
function ReasoningNode({ msg }: { msg: Message }) {
  const streaming = isStreaming(msg);
  useTicker(streaming);

  const start = msg.thinkingStartedAt;
  const end = msg.thinkingEndedAt;
  const elapsed = start !== undefined ? (end ?? Date.now()) - start : undefined;
  const body = (msg.thinkingContent ?? "").trim();

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
        {/* label row — no toggle; reasoning is always visible below it */}
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] text-ink/55">
          <Brain
            size={12}
            weight={streaming ? "fill" : "regular"}
            className={streaming ? "animate-icon-pulse text-indigo-300" : "text-ink/45"}
          />
          <span className="min-w-0 flex-1 truncate">{streaming ? "Thinking" : "Reasoning"}</span>
          {elapsed !== undefined && (
            <span className="shrink-0 tabular-nums text-ink/30">{fmtClock(elapsed)}</span>
          )}
        </div>

        {/* the thought itself — rendered out loud, in chronological place. Uses
            font-mono (the final-answer typeface) so reasoning, tool I/O and the
            answer all read as one unified surface. */}
        {body ? (
          <p className="mt-0.5 whitespace-pre-wrap px-1 font-mono text-[12px] leading-relaxed text-ink/75 [overflow-wrap:anywhere]">
            {body}
            {streaming && (
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-indigo-400/70 align-text-bottom" />
            )}
          </p>
        ) : streaming ? (
          <p className="mt-0.5 px-1 font-mono text-[11.5px] italic text-ink/40">thinking…</p>
        ) : null}
      </div>
    </div>
  );
}

/* ── tool node (flat, hugged chip — rendered inline on the timeline rail) ── */
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
        {/* Header is a flat chip hugging its content — not a full-width bar and
            no box chrome, so it sits in linestep with the reasoning rows. The
            expanded panel below still spans the column's full width. */}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11.5px] hover:bg-ink/5"
        >
          <Icon size={12} className={["shrink-0", failed ? "text-amber-200" : accent.text].join(" ")} />
          <span className={["shrink-0 font-mono font-medium", failed ? "text-amber-100" : accent.text].join(" ")}>
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
                "max-w-[180px] truncate rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[10px] text-ink/65",
                isDiffable ? "hover:bg-ink/10 hover:text-ink/90" : "",
              ].join(" ")}
              title={msg.toolPath}
            >
              {baseName(msg.toolPath)}
            </span>
          )}
          {running ? (
            <span className="max-w-[160px] truncate text-[11px] text-ink/45">using {label}…</span>
          ) : (
            hasDiff && <DiffStat added={msg.linesAdded} removed={msg.linesRemoved} compact />
          )}
          {elapsed !== undefined && (
            <span className="ml-1 shrink-0 tabular-nums text-[10px] text-ink/30">
              {fmtElapsed(elapsed)}
            </span>
          )}
          <CaretDown
            size={9}
            className={["shrink-0 transition-transform", open ? "rotate-180" : ""].join(" ")}
          />
        </button>

        <Collapse open={open}>
          <div className="mt-1 rounded-lg border border-white/10 bg-ink/5 px-2.5 py-2 text-[11px]">
            {/* edit_file → a diff and nothing else, so the change is pinpointable.
                Every other tool → its real input + output, not a generic blurb. */}
            {msg.toolKind === "write" ? (
              <DiffView
                path={msg.toolPath}
                input={msg.toolInput}
                linesAdded={msg.linesAdded}
                linesRemoved={msg.linesRemoved}
              />
            ) : (
              <div className="flex flex-col gap-2">
                {msg.toolInput && (
                  <div className="min-w-0">
                    <div className="mb-0.5 text-[9px] uppercase tracking-wider text-ink/35">
                      {toolIOLabels(msg.toolKind).input}
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-ink/70 [overflow-wrap:anywhere]">
                      {msg.toolInput}
                    </pre>
                  </div>
                )}
                {msg.toolPreview && (
                  <div className="min-w-0">
                    <div className="mb-0.5 text-[9px] uppercase tracking-wider text-ink/35">
                      {toolIOLabels(msg.toolKind).output}
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-ink/70 [overflow-wrap:anywhere]">
                      {msg.toolPreview}
                    </pre>
                  </div>
                )}
                {!msg.toolInput && !msg.toolPreview && (
                  <span className="text-ink/40">No additional detail.</span>
                )}
              </div>
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
  tokens,
  status,
  startAt,
  hasActivity,
}: {
  answer: Message;
  totalMs: number;
  tokens: number;
  status: "running" | "error" | "done";
  startAt?: number;
  hasActivity: boolean;
}) {
  // First word capitalised — a status label, not a log line.
  const statusText = status === "running" ? "Running" : status === "error" ? "Error" : "Done";
  const statusColor =
    status === "error" ? "text-amber-300" : status === "running" ? "text-indigo-300" : "text-emerald-300/90";

  return (
    <div
      className={[
        "group flex w-full min-w-0 flex-col items-start gap-1.5",
        // A border-top sets the final answer apart from the reasoning above it.
        hasActivity ? "mt-3 border-t border-white/12 pt-3" : "mt-1",
      ].join(" ")}
    >
      {/* When a run fails, surface WHY right here — the structured error +
          stderr tail — instead of only flipping the footer to "Error". */}
      {answer.error && (
        <div className="w-full min-w-0">
          <ErrorBanner error={answer.error} />
        </div>
      )}

      {answer.content.length > 0 && (
        <div className="w-full min-w-0 max-w-full overflow-hidden break-words font-mono text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere] [word-break:break-word]">
          <Markdown>{answer.content}</Markdown>
        </div>
      )}

      {/* run roll-up — total · ~tokens · status (durations are text, not colour) */}
      <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-ink/40">
        {startAt !== undefined && <span className="tabular-nums">{fmtClock(totalMs)}</span>}
        {startAt !== undefined && <span className="text-ink/25">·</span>}
        <span className="tabular-nums">~{fmtTokenCount(tokens)} tokens</span>
        <span className="text-ink/25">·</span>
        <span className={statusColor}>{statusText}</span>
      </div>

      {/* hover-persistent action row */}
      {answer.content.length > 0 && (
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={answer.content} className="border border-white/10" />
        </div>
      )}
    </div>
  );
}
