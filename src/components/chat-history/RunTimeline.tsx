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
  Stack,
  type Icon,
} from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Message, ToolKind } from "../../stores/use-messages-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { Collapse } from "../Collapse";
import { ImageLightbox } from "../ImageLightbox";
import { ErrorBanner } from "../ErrorBanner";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { fmtElapsed } from "./MessageItem";
import { useTicker, fmtClock, fmtTokenCount } from "./timeline-util";
import { baseName, DiffStat, DiffView, toolIOLabels } from "./tool-summary";
import { CommandLine, CommandOutput } from "../../lib/syntax-highlight";
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
 * A rendered timeline row. Reasoning and short tool spans (1–2 calls) render
 * individually, in chronological order. A *run of 3+ consecutive tool calls
 * with NO reasoning between them* collapses into one `tool-group` accordion in
 * its exact chronological position — so a burst of back-to-back tool calls
 * doesn't sprawl, while interleaved reasoning + tools stay flat.
 */
export type RenderItem =
  | { kind: "reasoning"; msg: Message; key: string }
  | { kind: "tool"; msg: Message; key: string }
  | { kind: "tool-group"; msgs: Message[]; key: string };

/** Group maximal runs of consecutive tool nodes; only runs of >2 collapse. */
export function clusterNodes(nodes: RunNode[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < nodes.length) {
    if (nodes[i].type === "reasoning") {
      items.push({ kind: "reasoning", msg: nodes[i].msg, key: nodes[i].key });
      i++;
      continue;
    }
    const run: RunNode[] = [];
    while (i < nodes.length && nodes[i].type === "tool") {
      run.push(nodes[i]);
      i++;
    }
    if (run.length > 2) {
      items.push({
        kind: "tool-group",
        msgs: run.map((t) => t.msg),
        key: `grp-${run[0].key}`,
      });
    } else {
      for (const t of run) items.push({ kind: "tool", msg: t.msg, key: t.key });
    }
  }
  return items;
}

/** One-line summary for a collapsed tool group ("Read 3 files" / "5 tool calls"). */
export function groupSummary(msgs: Message[]): string {
  const n = msgs.length;
  const kinds = new Set(msgs.map((m) => m.toolKind));
  if (kinds.size === 1) {
    switch (msgs[0].toolKind) {
      case "write":
        return `Edited ${n} files`;
      case "read":
        return `Read ${n} files`;
      case "search":
        return `Ran ${n} searches`;
      case "run":
        return `Ran ${n} commands`;
    }
  }
  return `${n} tool calls`;
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
export function RunTimeline({
  messages,
  live,
  staleSince,
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
  /**
   * When the live agent has been silent past the stale threshold: the timestamp
   * of its last activity (the watchdog flags it but never kills). Drives the
   * non-blocking "agent may be stale" notice on the live tail. `null` while the
   * agent is moving or the run isn't the live one.
   */
  staleSince?: number | null;
}) {
  // Collapsed/expanded state of the settled-run "Worked for …" accordion.
  const [activityOpen, setActivityOpen] = useState(false);

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

  // ── final-answer resolution + salvage ──────────────────────────────────
  const answerEmpty = !answer || answer.content.trim().length === 0;

  // ReAct salvage: a settled, non-error run with no `Answer:` line ends on the
  // model's final Thought — its real last words (an actual conclusion, or e.g.
  // a "tool budget reached" note). Surface that as the answer instead of leaving
  // the run blank. Normal runs (which emit `Answer:`) are untouched.
  let recovered: string | undefined;
  let timelineNodes = nodes;
  if (!isRunning && status !== "error" && answerEmpty && nodes.length > 0) {
    const last = nodes[nodes.length - 1];
    if (last.type === "reasoning") {
      const text = (last.msg.thinkingContent ?? "").trim();
      if (text.length > 0) {
        recovered = text;
        timelineNodes = nodes.slice(0, -1);
      }
    }
  }

  // Settled with steps but nothing surfaceable → show an explicit notice rather
  // than a confusing blank (e.g. the reply was absorbed into the last tool's
  // output, or the agent hit its tool-call budget).
  const finishedEmpty =
    !isRunning && status !== "error" && answerEmpty && !recovered && nodes.length > 0;

  // Anything to render in the answer area: a real answer, a recovered one, the
  // empty-run notice, or an error banner.
  const hasAnswerArea =
    (!!answer && answer.content.length > 0) || !!recovered || finishedEmpty || status === "error";

  // Drives the final-answer divider: only when there's timeline activity above.
  const hasActivity = timelineNodes.length > 0;

  // The inline timeline — rail + interleaved reasoning/tool rows + live tail.
  // Unchanged; only WHERE it renders (inline vs. inside the settled accordion)
  // changes below.
  const timeline = (
    <div className="relative flex flex-col gap-1.5">
      {/* vertical rail line threaded behind the node markers */}
      <span
        className="pointer-events-none absolute bottom-2 left-[10px] top-2 w-px bg-white/12"
        aria-hidden
      />
      {/* Reasoning + tools render in chronological order. A burst of 3+ tool
          calls with no reasoning between them folds into one tool-group
          accordion at its place; everything else stays flat and inline. */}
      {clusterNodes(timelineNodes).map((item) =>
        item.kind === "reasoning" ? (
          <ReasoningNode key={item.key} msg={item.msg} />
        ) : item.kind === "tool" ? (
          <ToolNode key={item.key} msg={item.msg} />
        ) : (
          <ToolGroup key={item.key} msgs={item.msgs} />
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
      {/* Stale notice — the agent has gone silent past the threshold. We keep
          standing by (no kill); this just tells the user it might be wedged and
          that Stop is theirs to press. Shown even while a tool reads "running",
          since a hung tool is exactly the stale case. */}
      {isRunning && staleSince != null && (
        <div className="relative ml-1 flex items-start gap-1.5 rounded-md border border-amber-400/25 bg-amber-500/[0.07] px-2 py-1.5 text-[11px] leading-snug text-amber-100/85">
          <Warning size={12} weight="fill" className="mt-px shrink-0 text-amber-300/90" />
          <span>
            Agent may be stale — no output for{" "}
            <span className="tabular-nums">{fmtClock(now - staleSince)}</span>. Still
            standing by; press Stop to cancel if it's wedged.
          </span>
        </div>
      )}
    </div>
  );

  // Once the run has settled AND produced its answer, fold the whole activity
  // log into a single collapsed "Worked for …" accordion above the answer. While
  // the run is live (or it errored with no answer) the timeline stays inline so
  // you watch it think. Additive: the inline `timeline` renders verbatim inside.
  const settledIntoAccordion =
    !isRunning && hasActivity && hasAnswerArea && status !== "error";

  return (
    <div className="flex w-full min-w-0 flex-col">
      {settledIntoAccordion ? (
        <div className="flex flex-col">
          <button
            onClick={() => setActivityOpen((v) => !v)}
            aria-expanded={activityOpen}
            className="inline-flex max-w-full items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-sm text-ink/55 transition-colors hover:bg-ink/5 hover:text-ink/80"
          >
            <CaretDown
              size={10}
              className={["shrink-0 transition-transform", activityOpen ? "" : "-rotate-90"].join(" ")}
            />
            <span className="tabular-nums">Worked for {fmtClock(totalMs)}</span>
          </button>
          <Collapse open={activityOpen}>
            <div className="mt-1.5">{timeline}</div>
          </Collapse>
        </div>
      ) : (
        timeline
      )}

      {/* ── final answer + footer + copy ── */}
      {answer && hasAnswerArea && (
        <AnswerBlock
          answer={answer}
          totalMs={totalMs}
          tokens={tokens}
          status={status}
          startAt={startAt}
          hasActivity={hasActivity}
          recovered={recovered}
          finishedEmpty={finishedEmpty}
        />
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
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-sm text-ink/55">
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
          <p className="mt-0.5 whitespace-pre-wrap px-1 font-mono text-xs leading-relaxed text-ink/75 [overflow-wrap:anywhere]">
            {body}
            {streaming && (
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-indigo-400/70 align-text-bottom" />
            )}
          </p>
        ) : streaming ? (
          <p className="mt-0.5 px-1 font-mono text-xs italic text-ink/40">thinking…</p>
        ) : null}
      </div>
    </div>
  );
}

/* ── tool node (flat, hugged chip — rendered inline on the timeline rail) ── */
function ToolNode({ msg }: { msg: Message }) {
  const openDiffForFile = useWorkspaceStore((s) => s.openDiffForFile);
  const [open, setOpen] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const running = msg.toolStatus === "running";
  const failed = msg.toolStatus === "failed";
  useTicker(running);

  // Captured-image result (e.g. capture-window): render the actual picture inline
  // via the Tauri asset protocol so the user sees what was captured in real time,
  // not a bare path. Click to open the full-screen lightbox.
  const imageSrc = msg.toolImagePath ? convertFileSrc(msg.toolImagePath) : null;

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

        {/* Captured image — shown inline the moment the tool settles, always
            visible (no expand needed). Click enlarges via the shared lightbox. */}
        {imageSrc && (
          <button
            type="button"
            onClick={() => setLightbox(true)}
            className="mt-1.5 block overflow-hidden rounded-lg border border-white/10 bg-ink/5 transition-colors hover:border-white/25"
            title="Click to enlarge"
          >
            <img
              src={imageSrc}
              alt={msg.toolPath ? baseName(msg.toolPath) : "captured window"}
              className="max-h-48 w-auto max-w-full object-contain"
            />
          </button>
        )}
        {lightbox && msg.toolImagePath && (
          <ImageLightbox
            path={msg.toolImagePath}
            name={msg.toolPath ? baseName(msg.toolPath) : "Captured window"}
            onClose={() => setLightbox(false)}
          />
        )}

        <Collapse open={open}>
          <div className="mt-1 rounded-lg border border-white/10 bg-ink/5 px-2.5 py-2 text-[11px]">
            {/* Captured image → the source path (the picture itself is shown
                inline above). edit_file → a diff and nothing else, so the change
                is pinpointable. Every other tool → its real input + output. */}
            {imageSrc ? (
              <div className="flex flex-col gap-1">
                <div className="text-[9px] uppercase tracking-wider text-ink/35">
                  Captured image
                </div>
                <span className="font-mono text-[10.5px] text-ink/70 [overflow-wrap:anywhere]">
                  {msg.toolImagePath}
                </span>
              </div>
            ) : msg.toolKind === "write" ? (
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
                    {/* A shell command (run) is colorized by role — verb, path,
                        body — so it reads at a glance; other inputs (a query, a
                        path) stay as plain monospace. */}
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-ink/70 [overflow-wrap:anywhere]">
                      {msg.toolKind === "run" ? (
                        <CommandLine text={msg.toolInput} />
                      ) : (
                        msg.toolInput
                      )}
                    </pre>
                  </div>
                )}
                {msg.toolPreview && (
                  <div className="min-w-0">
                    <div className="mb-0.5 text-[9px] uppercase tracking-wider text-ink/35">
                      {toolIOLabels(msg.toolKind).output}
                    </div>
                    {/* Terminal output for a run tool: command lines echoed in
                        the output are colorized in place (many agents report the
                        command inside the result, not as a separate input);
                        listings/stdout stay neutral. Other tools' output is plain. */}
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] text-ink/70 [overflow-wrap:anywhere]">
                      {msg.toolKind === "run" ? (
                        <CommandOutput text={msg.toolPreview} />
                      ) : (
                        msg.toolPreview
                      )}
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

/* ── tool group (3+ back-to-back tool calls, no reasoning between) ──────── */
function ToolGroup({ msgs }: { msgs: Message[] }) {
  const [open, setOpen] = useState(false);
  const anyRunning = msgs.some(isRunningTool);
  const anyFailed = msgs.some((m) => m.toolStatus === "failed");
  useTicker(anyRunning);

  const starts = msgs
    .map((m) => m.toolStartedAt)
    .filter((x): x is number => x !== undefined);
  const ends = msgs
    .filter((m) => m.toolStartedAt !== undefined && m.toolElapsedMs !== undefined)
    .map((m) => m.toolStartedAt! + m.toolElapsedMs!);
  const earliest = starts.length ? Math.min(...starts) : undefined;
  const latest = ends.length ? Math.max(...ends) : undefined;
  const elapsed =
    earliest === undefined
      ? undefined
      : Math.max(0, (anyRunning ? Date.now() : latest ?? Date.now()) - earliest);

  return (
    <div className="relative flex gap-2.5 pl-1">
      <span className="relative z-10 mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
        {anyRunning ? (
          <span className="h-2 w-2 animate-pulse rounded-full bg-ink/45" />
        ) : anyFailed ? (
          <Warning size={12} weight="fill" className="text-amber-400" />
        ) : (
          <CheckCircle size={12} weight="fill" className="text-ink/40" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {/* Flat hugged header — same chip language as the single tool rows. */}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-ink/60 transition-colors hover:bg-ink/5 hover:text-ink/85"
        >
          <Stack size={12} className="shrink-0 text-ink/45" />
          <span className="truncate font-medium">
            {anyRunning ? `Running ${msgs.length} tools` : groupSummary(msgs)}
          </span>
          {elapsed !== undefined && (
            <span className="ml-1 shrink-0 tabular-nums text-ink/30">
              {fmtElapsed(elapsed)}
            </span>
          )}
          <CaretDown
            size={10}
            className={["shrink-0 transition-transform", open ? "" : "-rotate-90"].join(" ")}
          />
        </button>
        {/* Expanded → the individual tool chips, in order, unchanged. */}
        <Collapse open={open}>
          <div className="mt-1 flex flex-col gap-1.5">
            {msgs.map((m) => (
              <ToolNode key={m.id} msg={m} />
            ))}
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
  recovered,
  finishedEmpty,
}: {
  answer: Message;
  totalMs: number;
  tokens: number;
  status: "running" | "error" | "done";
  startAt?: number;
  hasActivity: boolean;
  /** Model's final-step text, surfaced when no `Answer:` was emitted. */
  recovered?: string;
  /** Run settled with steps but produced nothing surfaceable. */
  finishedEmpty?: boolean;
}) {
  // First word capitalised — a status label, not a log line.
  const statusText = status === "running" ? "Running" : status === "error" ? "Error" : "Done";
  const statusColor =
    status === "error" ? "text-amber-300" : status === "running" ? "text-indigo-300" : "text-emerald-300/90";

  // The body is the real answer when present, else the salvaged final-step text.
  const bodyText = answer.content.trim().length > 0 ? answer.content : recovered ?? "";
  const isRecovered = answer.content.trim().length === 0 && !!recovered;

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

      {/* Salvaged reply: the model concluded without an `Answer:` tag, so this is
          its final step surfaced as the answer — labelled so it reads honestly. */}
      {isRecovered && !answer.error && (
        <div className="flex items-center gap-1.5 text-[10px] text-ink/35">
          <Brain size={11} className="text-ink/30" />
          <span>Recovered from the model's final step — no final-answer tag was emitted</span>
        </div>
      )}

      {bodyText.length > 0 && (
        <div className="w-full min-w-0 max-w-full overflow-hidden break-words font-mono text-sm leading-relaxed text-ink [overflow-wrap:anywhere] [word-break:break-word]">
          <Markdown>{bodyText}</Markdown>
        </div>
      )}

      {/* Settled with steps but no surfaceable reply — make it explicit. */}
      {finishedEmpty && !answer.error && (
        <div className="font-mono text-[12px] italic leading-relaxed text-ink/45">
          The agent finished its tool calls but didn't return a final answer. Its
          reply may be inside the last tool's output above, or it ran out of
          tool-call budget — try a more specific prompt or raise the agent's limit.
        </div>
      )}

      {/* run roll-up — total · ~tokens · status (durations are text, not colour) */}
      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink/40">
        {startAt !== undefined && <span className="tabular-nums">{fmtClock(totalMs)}</span>}
        {startAt !== undefined && <span className="text-ink/25">·</span>}
        <span className="tabular-nums">~{fmtTokenCount(tokens)} tokens</span>
        <span className="text-ink/25">·</span>
        <span className={statusColor}>{statusText}</span>
      </div>

      {/* hover-persistent action row */}
      {bodyText.length > 0 && (
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={bodyText} className="border border-white/10" />
        </div>
      )}
    </div>
  );
}
