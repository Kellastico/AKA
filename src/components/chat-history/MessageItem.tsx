import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  File,
  Folder,
  Image,
  Link,
  NotePencil,
  Eye,
  TerminalWindow,
  MagnifyingGlass,
  CheckCircle,
  XCircle,
  Cube,
  Robot,
  Brain,
  CaretDown,
  type Icon,
} from "@phosphor-icons/react";
import {
  Message,
  MessageAttachment,
  ToolKind,
} from "../../stores/use-messages-store";
import { useAgentsStore } from "../../stores/use-agents-store";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { ErrorBanner } from "../ErrorBanner";
import { Collapse } from "../Collapse";
import { activeSummary, DiffStat } from "./tool-summary";

const ATTACH_ICONS: Record<MessageAttachment["kind"], Icon> = {
  file: File,
  folder: Folder,
  image: Image,
  url: Link,
};

/**
 * Per-element Tailwind classes for ReactMarkdown so assistant responses get
 * proper heading hierarchy, list spacing, code styling, etc. Mirrors what
 * @tailwindcss/typography would give us — kept inline so we don't pull in
 * the plugin just for chat bubbles.
 */
const MD_COMPONENTS = {
  // All assistant body text — including headings — uses Space Mono so the
  // chat reads as an agentic-coder surface, not a generic chat app. Hierarchy
  // is conveyed through size + weight, not typeface.
  h1: ({ ...p }) => (
    <h1
      className="mt-4 mb-2 font-mono text-[22px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h2: ({ ...p }) => (
    <h2
      className="mt-3.5 mb-2 font-mono text-[19px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h3: ({ ...p }) => (
    <h3
      className="mt-3 mb-1.5 font-mono text-[16px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h4: ({ ...p }) => (
    <h4
      className="mt-2.5 mb-1 font-mono text-[14px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h5: ({ ...p }) => (
    <h5
      className="mt-2 mb-1 font-mono text-[12px] font-bold uppercase tracking-wider text-ink/85"
      {...p}
    />
  ),
  h6: ({ ...p }) => (
    <h6
      className="mt-2 mb-1 font-mono text-[11px] font-bold uppercase tracking-wider text-ink/70"
      {...p}
    />
  ),
  p: ({ ...p }) => (
    <p className="my-1.5 font-mono text-[13px] leading-relaxed text-ink/90" {...p} />
  ),
  strong: ({ ...p }) => (
    <strong className="font-semibold text-ink" {...p} />
  ),
  em: ({ ...p }) => <em className="text-ink/85" {...p} />,
  a: ({ ...p }) => (
    <a
      className="text-blue-300 underline-offset-2 hover:text-blue-200"
      target="_blank"
      rel="noreferrer"
      {...p}
    />
  ),
  ul: ({ ...p }) => (
    <ul
      className="my-1.5 ml-5 list-disc space-y-0.5 font-mono text-[13px] marker:text-ink/40"
      {...p}
    />
  ),
  ol: ({ ...p }) => (
    <ol
      className="my-1.5 ml-5 list-decimal space-y-0.5 font-mono text-[13px] marker:text-ink/40"
      {...p}
    />
  ),
  li: ({ ...p }) => <li className="text-ink/90" {...p} />,
  blockquote: ({ ...p }) => (
    <blockquote
      className="my-2 border-l-2 border-white/20 pl-3 italic text-ink/70"
      {...p}
    />
  ),
  hr: ({ ...p }) => <hr className="my-3 border-white/10" {...p} />,
  code: ({
    inline,
    className,
    children,
    ...p
  }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  }) => {
    if (inline) {
      return (
        <code
          className="rounded bg-white/8 px-1 py-0.5 font-mono text-[12.5px] text-ink"
          {...p}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={`${className ?? ""} font-mono text-[12px]`} {...p}>
        {children}
      </code>
    );
  },
  pre: ({ ...p }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 text-[12px] text-ink/90"
      {...p}
    />
  ),
  table: ({ ...p }) => (
    <div className="my-2 overflow-x-auto">
      <table
        className="border-collapse text-left text-[13px] text-ink/85"
        {...p}
      />
    </div>
  ),
  th: ({ ...p }) => (
    <th
      className="border border-white/10 bg-white/5 px-2 py-1 font-medium"
      {...p}
    />
  ),
  td: ({ ...p }) => (
    <td className="border border-white/10 px-2 py-1" {...p} />
  ),
};

const TOOL_ICONS: Record<ToolKind, Icon> = {
  write: NotePencil,
  read: Eye,
  run: TerminalWindow,
  search: MagnifyingGlass,
};

const TOOL_VERBS: Record<ToolKind, string> = {
  write: "wrote",
  read: "read",
  run: "ran",
  search: "searched",
};

/**
 * Per-tool-kind accent colour for the bullet + status icon. Picked to be
 * distinct on AKA's purple background but quiet enough not to fight the
 * Reasoning accordion's white-frost cards.
 */
const TOOL_ACCENTS: Record<ToolKind, { dot: string; text: string }> = {
  read:   { dot: "bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.45)]",       text: "text-sky-200" },
  write:  { dot: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.45)]",      text: "text-amber-200" },
  run:    { dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.45)]",    text: "text-emerald-200" },
  search: { dot: "bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.45)]",   text: "text-fuchsia-200" },
};

/** Format elapsed ms into "17ms" / "1.2s" / "1m 4s". */
function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function MessageItem({ message }: { message: Message }) {
  return (
    <div className="animate-message-in">
      {message.role === "tool" ? (
        <ToolMessage message={message} />
      ) : message.role === "user" ? (
        <UserMessage message={message} />
      ) : (
        <AssistantMessage message={message} />
      )}
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex min-w-0 flex-col items-end gap-1.5">
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
          {message.attachments.map((a, i) => {
            const Icon = ATTACH_ICONS[a.kind];
            return (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] text-white/85 backdrop-blur-md"
              >
                <Icon size={10} />
                <span className="max-w-[120px] truncate">{a.name}</span>
              </span>
            );
          })}
        </div>
      )}
      <div className="max-w-[85%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl rounded-tr-md border border-white/20 bg-blue-500/60 px-3 py-2 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_4px_20px_rgba(0,0,0,0.4)] backdrop-blur-3xl">
        {message.content}
      </div>
      <span className="text-[10px] text-ink/40">{message.timestamp}</span>
    </div>
  );
}

function AssistantMessage({ message }: { message: Message }) {
  const [thinkOpen, setThinkOpen] = useState(false);
  const isPending =
    message.pendingSince !== undefined && message.content.length === 0;

  // Reasoning is "live" while the model is still streaming its thinking
  // (started, not yet ended). Pulse the Brain only then — and only while the
  // accordion is collapsed, so an open panel stays calm.
  const reasoningLive =
    message.thinkingStartedAt !== undefined &&
    message.thinkingEndedAt === undefined;

  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-1.5">
      {message.thinkingContent && (
        <div className="w-full">
          <button
            onClick={() => setThinkOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-ink/40 hover:bg-ink/5 hover:text-ink/60"
          >
            <Brain
              size={12}
              weight={reasoningLive && !thinkOpen ? "fill" : "regular"}
              className={reasoningLive && !thinkOpen ? "animate-icon-pulse text-ink/70" : ""}
            />
            <span>Reasoning</span>
            <ReasoningElapsed
              startedAt={message.thinkingStartedAt}
              endedAt={message.thinkingEndedAt}
            />
            <CaretDown
              size={10}
              className={["transition-transform", thinkOpen ? "rotate-180" : ""].join(" ")}
            />
          </button>
          <Collapse open={thinkOpen}>
            <div
              className={[
                "mt-1 rounded-xl px-3 py-2.5",
                "border border-white/20 bg-white/12 backdrop-blur-xl",
                "shadow-[0_4px_20px_rgba(255,255,255,0.04),inset_0_1px_0_rgba(255,255,255,0.15)]",
                "text-[11px] leading-relaxed text-ink/75",
                "whitespace-pre-wrap [overflow-wrap:anywhere]",
              ].join(" ")}
            >
              {message.thinkingContent}
            </div>
          </Collapse>
        </div>
      )}
      {message.error && (
        <div className="w-full max-w-[85%]">
          <ErrorBanner error={message.error} />
        </div>
      )}
      {isPending && <ThinkingBubble since={message.pendingSince!} />}
      {message.content && (
        <div className="w-full min-w-0 max-w-full overflow-hidden break-words font-mono text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere] [word-break:break-word]">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {message.content}
          </ReactMarkdown>
        </div>
      )}
      <MetaRow message={message} />
    </div>
  );
}

/**
 * Compact elapsed-time chip rendered next to the "Reasoning" label. Mirrors
 * the ThinkingBubble's timer so the two states feel like the same idea:
 * "the model is thinking — here's how long." Ticks live while thinking is
 * in progress (`endedAt` undefined), then freezes at the final duration.
 */
function ReasoningElapsed({
  startedAt,
  endedAt,
}: {
  startedAt?: number;
  endedAt?: number;
}) {
  const [, force] = useState(0);
  const live = startedAt !== undefined && endedAt === undefined;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  if (startedAt === undefined) return null;
  const end = endedAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const elapsed =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <span className="tabular-nums text-ink/30">· {elapsed}</span>;
}

/**
 * Pulsing "thinking" placeholder shown between submit and the first chunk
 * for models that don't emit a reasoning stream (Gemma, vanilla Llama, etc).
 * Live-updates the elapsed time every 100ms so the user knows the model is
 * still working, not stuck.
 */
function ThinkingBubble({ since }: { since: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    // 1s tick is enough since we only display whole seconds.
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const totalSeconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const elapsed =
    totalSeconds < 60
      ? `${totalSeconds}s`
      : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;

  return (
    <div
      className={[
        "inline-flex items-center gap-2.5 rounded-2xl px-3 py-2 text-[12px] text-ink/75",
        "border border-white/20 bg-white/12 backdrop-blur-xl",
        "shadow-[0_4px_20px_rgba(255,255,255,0.04),inset_0_1px_0_rgba(255,255,255,0.15)]",
      ].join(" ")}
    >
      <span className="inline-flex gap-1">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink/50 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink/50 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink/50 [animation-delay:300ms]" />
      </span>
      <span>Thinking</span>
      <span className="tabular-nums text-ink/45">{elapsed}</span>
    </div>
  );
}

/**
 * Claude-Code-style tool row. Each tool call renders as a colored bullet
 * + tool name + path + elapsed time, with a `⎿ <preview>` continuation
 * line below carrying the result summary.
 *
 * Three states drive the bullet:
 *   "running" — pulsing colored dot, no text-state suffix
 *   "done"    — solid ✓ in the tool's accent colour
 *   "failed"  — ✗ in red
 *
 * Old messages without `toolStatus` default to "done" so historical
 * traces keep rendering correctly.
 */
function ToolMessage({ message }: { message: Message }) {
  const openDiffForFile = useWorkspaceStore((s) => s.openDiffForFile);
  if (!message.toolKind) return null;
  const accent = TOOL_ACCENTS[message.toolKind];
  const Icon = TOOL_ICONS[message.toolKind];
  const status = message.toolStatus ?? "done";
  const isDiffable =
    !!message.toolPath &&
    (message.linesAdded !== undefined || message.linesRemoved !== undefined);

  const label = message.toolName ?? TOOL_VERBS[message.toolKind];

  const statusIcon =
    status === "running" ? (
      <span
        className={[
          "inline-block h-2 w-2 shrink-0 animate-pulse rounded-full",
          accent.dot,
        ].join(" ")}
        aria-label="Running"
      />
    ) : status === "failed" ? (
      <XCircle size={12} weight="fill" className="shrink-0 text-red-400" />
    ) : (
      <CheckCircle
        size={12}
        weight="fill"
        className={["shrink-0", accent.text].join(" ")}
      />
    );

  const headerRow = (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      {statusIcon}
      <Icon size={12} className={accent.text} />
      <span className={["font-mono font-medium", accent.text].join(" ")}>
        {label}
      </span>
      {message.toolPath && (
        <code className="truncate rounded bg-ink/5 px-1.5 py-0.5 font-mono text-[10px] text-ink/65">
          {message.toolPath}
        </code>
      )}
      {message.toolElapsedMs !== undefined && (
        <span className="tabular-nums text-[10px] text-ink/35">
          · {fmtElapsed(message.toolElapsedMs)}
        </span>
      )}
    </div>
  );

  // Continuation line: `⎿ …` indented under the bullet — quiet, monospaced.
  //   running → live ≤25-word active summary ("Writing changes to App.tsx")
  //   done    → result preview + an accessible "+x code added | −x removed"
  //             diff chip when the action changed code.
  const hasDiff =
    message.linesAdded !== undefined || message.linesRemoved !== undefined;
  const hasPreview = !!message.toolPreview || hasDiff;

  const previewRow =
    status === "running" ? (
      <div className="ml-[14px] flex min-w-0 items-center gap-1.5 text-[11px] text-ink/55">
        <span className="text-ink/30">⎿</span>
        <span className="animate-pulse truncate font-mono text-ink/70">
          {activeSummary(message)}
        </span>
      </div>
    ) : hasPreview ? (
      <div className="ml-[14px] flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink/50">
        <span className="text-ink/30">⎿</span>
        {message.toolPreview && (
          <span className="font-mono text-ink/65">{message.toolPreview}</span>
        )}
        {hasDiff && (
          <DiffStat added={message.linesAdded} removed={message.linesRemoved} />
        )}
      </div>
    ) : null;

  const body = (
    <div className="flex flex-col items-start gap-0.5">
      {headerRow}
      {previewRow}
    </div>
  );

  return (
    <div className="flex flex-col items-start gap-0.5">
      {isDiffable ? (
        <button
          type="button"
          onClick={() => openDiffForFile(message.toolPath!)}
          className="-mx-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-ink/5 focus:bg-ink/5 focus:outline-none"
          aria-label={`Open diff for ${message.toolPath}`}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </div>
  );
}

function MetaRow({ message }: { message: Message }) {
  const agent = useAgentsStore((s) =>
    message.agentId ? s.agents.find((a) => a.id === message.agentId) : undefined
  );

  const parts: React.ReactNode[] = [];
  if (message.modelId) {
    parts.push(
      <span key="model" className="inline-flex items-center gap-0.5">
        <Cube size={9} />
        {message.modelId}
      </span>
    );
  }
  if (agent) {
    parts.push(
      <span key="agent" className="inline-flex items-center gap-0.5">
        <Robot size={9} />
        {agent.name}
      </span>
    );
  }
  parts.push(
    <span key="time" className="tabular-nums">
      {message.timestamp}
    </span>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] text-ink/40">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="text-ink/25">·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}
