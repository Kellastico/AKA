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
import type { Message, ToolKind } from "../../stores/use-messages-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { Collapse } from "../Collapse";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { fmtElapsed } from "./MessageItem";
import { useTicker, fmtClock, approxTokens } from "./timeline-util";
import { baseName, DiffStat } from "./tool-summary";

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
 * A rendered timeline row. Reasoning stands alone; a single/pair of tool calls
 * after a Thought render as inline chips, but a *run* of 3+ consecutive tool
 * calls collapses into one `tool-group` accordion so the timeline stays
 * readable instead of sprawling.
 */
export type RenderItem =
  | { kind: "reasoning"; msg: Message; key: string }
  | { kind: "tool"; msg: Message; key: string }
  | { kind: "tool-group"; msgs: Message[]; key: string };

/** Group consecutive tool nodes; 3+ in a row become a single collapsible group. */
export function clusterNodes(nodes: RunNode[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < nodes.length) {
    if (nodes[i].type === "reasoning") {
      items.push({ kind: "reasoning", msg: nodes[i].msg, key: nodes[i].key });
      i++;
      continue;
    }
    const tools: RunNode[] = [];
    while (i < nodes.length && nodes[i].type === "tool") {
      tools.push(nodes[i]);
      i++;
    }
    if (tools.length > 2) {
      items.push({
        kind: "tool-group",
        msgs: tools.map((t) => t.msg),
        key: `grp-${tools[0].key}`,
      });
    } else {
      for (const t of tools) items.push({ kind: "tool", msg: t.msg, key: t.key });
    }
  }
  return items;
}

/** One-line summary for a collapsed tool group ("Ran 3 commands" / "5 tool calls"). */
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

/** The most common tool kind in a group — drives its icon. */
function dominantKind(msgs: Message[]): ToolKind {
  const counts = {} as Record<ToolKind, number>;
  for (const m of msgs) if (m.toolKind) counts[m.toolKind] = (counts[m.toolKind] ?? 0) + 1;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as ToolKind) ?? "run";
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

  return (
    <div className="flex w-full min-w-0 flex-col">
      {/* ── interleaved timeline — flat in the thread, no container ── */}
      <div className="relative flex flex-col gap-1.5">
        {/* vertical rail line threaded behind the node markers */}
        <span
          className="pointer-events-none absolute bottom-2 left-[10px] top-2 w-px bg-white/12"
          aria-hidden
        />
        {clusterNodes(nodes).map((item) =>
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
      </div>

      {/* ── final answer + footer + copy ── */}
      {answer && (answer.content.length > 0 || status === "error") && (
        <AnswerBlock answer={answer} totalMs={totalMs} chars={chars} status={status} startAt={startAt} />
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

        {/* the thought itself — rendered out loud, in chronological place */}
        {body ? (
          <p className="mt-0.5 whitespace-pre-wrap px-1 text-[11.5px] leading-relaxed text-ink/75 [overflow-wrap:anywhere]">
            {body}
            {streaming && (
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-indigo-400/70 align-text-bottom" />
            )}
          </p>
        ) : streaming ? (
          <p className="mt-0.5 px-1 text-[11px] italic text-ink/40">thinking…</p>
        ) : null}
      </div>
    </div>
  );
}

/* ── tool node (compact chip — used inline and inside a tool group) ────── */
function ToolNode({ msg, nested = false }: { msg: Message; nested?: boolean }) {
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
    <div className={["relative flex gap-2.5", nested ? "pl-6" : "pl-1"].join(" ")}>
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

/* ── tool group (3+ consecutive tool calls collapse into one accordion) ── */
function ToolGroup({ msgs }: { msgs: Message[] }) {
  const [open, setOpen] = useState(false);
  const anyRunning = msgs.some(isRunningTool);
  const anyFailed = msgs.some((m) => m.toolStatus === "failed");
  useTicker(anyRunning);

  const kind = dominantKind(msgs);
  const accent = TOOL_ACCENT[kind];
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
          <span className={["h-2 w-2 animate-pulse rounded-full", accent.dot].join(" ")} />
        ) : anyFailed ? (
          <Warning size={12} weight="fill" className="text-amber-400" />
        ) : (
          <CheckCircle size={12} weight="fill" className={accent.text} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11.5px] text-ink/70 hover:bg-ink/5 hover:text-ink/90"
        >
          <Stack size={12} className="text-ink/50" />
          <span className="min-w-0 flex-1 truncate font-medium">
            {anyRunning ? `Running ${msgs.length} tools` : groupSummary(msgs)}
          </span>
          {elapsed !== undefined && (
            <span className="shrink-0 tabular-nums text-[10px] text-ink/30">
              {fmtElapsed(elapsed)}
            </span>
          )}
          <CaretDown
            size={9}
            className={["shrink-0 transition-transform", open ? "rotate-180" : ""].join(" ")}
          />
        </button>
        <Collapse open={open}>
          <div className="mt-1 flex flex-col gap-1">
            {msgs.map((m) => (
              <ToolNode key={m.id} msg={m} nested />
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
          <CopyButton text={answer.content} className="border border-white/10" />
        </div>
      )}
    </div>
  );
}
