import { useEffect, useRef, useState } from "react";
import { CaretDown, BookOpenText, FileText } from "@phosphor-icons/react";
import { save } from "@tauri-apps/plugin-dialog";
import { Popover } from "../Popover";
import {
  useActiveSessionRunning,
  useActiveSessionTokensPerSec,
  useChatStore,
} from "../../stores/use-chat-store";
import { useAttachmentsStore } from "../../stores/use-attachments-store";
import { useAgentsStore, Agent } from "../../stores/use-agents-store";
import { useMessagesStore } from "../../stores/use-messages-store";
import { useProjectsStore } from "../../stores/use-projects-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import {
  useTokenCounterStore,
  type TokenStatus,
} from "../../stores/use-token-counter-store";
import { writeTextFile, getMemoryUsage, type MemoryUsage } from "../../lib/tauri/commands";

function formatGB(gb: number) {
  if (gb < 1) return `${(gb * 1024).toFixed(0)} MB`;
  return `${gb.toFixed(2)} GB`;
}

function formatTokens(n: number) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
}

function statusTone(status: TokenStatus): string {
  switch (status) {
    case "ok":
      return "text-ink/50";
    case "warn":
      return "text-amber-400";
    case "danger":
    case "over":
      return "text-red-500";
  }
}

export function UsageMeter() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [compressing, setCompressing] = useState(false);

  const inputText = useChatStore((s) => s.inputText);
  const running = useActiveSessionRunning();
  const tokensPerSec = useActiveSessionTokensPerSec();
  const attachments = useAttachmentsStore((s) => s.items);
  // Use the real runtime selection — this is what ModelPicker writes to.
  const selectedId = useRuntimeStore((s) => s.selectedModelId);
  const activeBaseUrl = useRuntimeStore((s) => s.active?.baseUrl ?? null);
  const agent = useAgentsStore((s) =>
    s.agents.find((a) => a.id === s.selectedAgentId)
  );

  // Live counter from `count_tokens(sessionMessages)` + `get_context_limit(model)`.
  const used = useTokenCounterStore((s) => s.used);
  const limit = useTokenCounterStore((s) => s.limit);
  const ratio = useTokenCounterStore((s) => s.ratio);
  const status = useTokenCounterStore((s) => s.status);

  // Hide the meter until a model is actually selected.
  if (!selectedId) return null;

  const pct = ratio * 100;
  const tone = statusTone(status);

  const handleCompress = async () => {
    if (compressing) return;
    setCompressing(true);
    try {
      const messages = useMessagesStore.getState().messages;
      const ps = useProjectsStore.getState();
      const project = ps.projects.find((p) => p.id === ps.activeProjectId);
      const session = project?.sessions.find((s) => s.id === ps.activeSessionId);
      const sessionTitle = session?.title ?? "session";
      const projectName = project?.name ?? "project";

      const md = buildChatMarkdown({
        modelId: selectedId,
        agentName: agent?.name ?? "—",
        sessionTitle,
        projectName,
        messages,
        inputText,
        attachments,
        used,
        limit,
        pct,
      });

      const safeTitle = sessionTitle.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60);
      const datestamp = new Date().toISOString().split("T")[0];
      const defaultName = `aka-${safeTitle || "chat"}-${datestamp}.md`;

      // Tauri's native save dialog — returns null if the user cancels.
      // Using browser <a download> here would kill the WKWebView because
      // there's no download handler registered on the Tauri shell.
      const targetPath = await save({
        title: "Compress chat to .md",
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!targetPath) {
        setCompressing(false);
        return;
      }

      await writeTextFile(targetPath, md);

      useRuntimeStore.getState().pushToast({
        kind: "info",
        text: `Chat compressed to ${targetPath.split(/[/\\]/).pop() ?? targetPath}`,
      });
      setOpen(false);
    } catch (err) {
      useRuntimeStore.getState().pushToast({
        kind: "error",
        text:
          err instanceof Error
            ? `Couldn't save chat: ${err.message}`
            : "Couldn't save chat.",
      });
    } finally {
      setCompressing(false);
    }
  };

  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen((v) => !v)}
        aria-label="Usage details"
        className={[
          "inline-flex items-center gap-2 rounded-full border border-transparent px-2.5 py-1.5 text-[10px] text-white/60",
          "transition-all hover:border-white/15 hover:bg-white/10 hover:text-white",
          "focus-visible:border-white/15 focus-visible:bg-white/10 focus-visible:text-white focus-visible:outline-none",
        ].join(" ")}
      >
        <BookOpenText size={12} className="shrink-0" />
        <span className={["tabular-nums", tone].join(" ")}>
          ~{formatTokens(used)} / {formatTokens(limit)}
        </span>
        <CaretDown
          size={10}
          className={[
            "shrink-0 text-ink/40 transition-transform",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref}>
        <StatsPanel
          modelId={selectedId}
          agent={agent}
          used={used}
          limit={limit}
          pct={pct}
          status={status}
          running={running}
          tokensPerSec={tokensPerSec}
          runtimeBaseUrl={activeBaseUrl}
          compressing={compressing}
          onCompress={() => void handleCompress()}
        />
      </Popover>
    </>
  );
}

function StatsPanel({
  modelId,
  agent,
  used,
  limit,
  pct,
  status,
  running,
  tokensPerSec,
  runtimeBaseUrl,
  compressing,
  onCompress,
}: {
  modelId: string;
  agent: Agent | undefined;
  used: number;
  limit: number;
  pct: number;
  status: TokenStatus;
  running: boolean;
  tokensPerSec: number;
  runtimeBaseUrl: string | null;
  compressing: boolean;
  onCompress: () => void;
}) {
  void modelId;
  void agent;

  // Poll real memory every 3 s while the panel is mounted (i.e. popover open).
  const [mem, setMem] = useState<MemoryUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      const result = await getMemoryUsage(runtimeBaseUrl).catch(() => null);
      if (!cancelled && result) setMem(result);
    };
    void fetch();
    const id = setInterval(() => void fetch(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runtimeBaseUrl]);

  const totalRamGB = mem ? mem.totalMb / 1024 : null;
  const ramLabel = totalRamGB !== null && totalRamGB > 0
    ? formatGB(totalRamGB)
    : "—";

  // Show a breakdown line when the model footprint is meaningful (> 100 MB).
  const showBreakdown = mem && mem.modelMb > 100;

  // Tokens/sec: while generating, show the live estimate; when idle, prefer the
  // runtime's exact last-generation rate (from /metrics) when available.
  const exactTps = mem?.lastTokensPerSec ?? null;
  const tpsValue = running
    ? tokensPerSec > 0
      ? `${tokensPerSec}`
      : "—"
    : exactTps && exactTps > 0
      ? exactTps.toFixed(1)
      : tokensPerSec > 0
        ? `${tokensPerSec}`
        : "—";

  const barColor =
    status === "ok"
      ? "bg-white/50"
      : status === "warn"
        ? "bg-amber-400"
        : "bg-red-500";
  const pctColor =
    status === "ok"
      ? "text-white"
      : status === "warn"
        ? "text-amber-400"
        : "text-red-500";

  return (
    <div className="text-xs">
      <div className="px-1 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">
        Context window
      </div>
      <div className="px-3 pb-3 pt-1">
        <div className="flex items-baseline gap-2">
          <span
            className={[
              "text-2xl font-semibold tabular-nums",
              pctColor,
            ].join(" ")}
          >
            {pct.toFixed(1)}%
          </span>
          <span className="text-white/40 tabular-nums">
            ~{formatTokens(used)} / {formatTokens(limit)}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className={["h-full transition-all", barColor].join(" ")}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>
      <div className="-mx-2 h-px bg-white/10" />
      <div className="space-y-1.5 px-3 py-3">
        <StatRow
          label={running ? "Tokens/sec" : "Last tokens/sec"}
          value={tpsValue}
        />
        <StatRow label="RAM" value={ramLabel} />
        {showBreakdown && mem && (
          <>
            <StatRow
              label="  AKA"
              value={formatGB(mem.appMb / 1024)}
              subtle
            />
            <StatRow
              label="  Model"
              value={formatGB(mem.modelMb / 1024)}
              subtle
            />
          </>
        )}
      </div>
      <div className="-mx-2 h-px bg-white/10" />
      <button
        onClick={onCompress}
        disabled={compressing}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <FileText size={14} />
        {compressing ? "Saving…" : "Compress chat to .md"}
      </button>
    </div>
  );
}

function StatRow({
  label,
  value,
  subtle,
  bold,
}: {
  label: string;
  value: string;
  subtle?: boolean;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span
        className={[
          "truncate",
          subtle ? "text-white/45" : "text-white/60",
          bold ? "font-medium text-white" : "",
        ].join(" ")}
      >
        {label}
      </span>
      <span
        className={[
          "shrink-0 tabular-nums",
          bold ? "font-semibold text-white" : "text-white/90",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

type MessageLike = ReturnType<typeof useMessagesStore.getState>["messages"][number];

/**
 * Serialise the full chat session — header metadata, every message in order,
 * plus the staged prompt + attachments — into a markdown document.
 *
 * Each role gets a header (`### You` / `### Assistant` / `### Tool`) and any
 * captured thinking blocks render under a collapsible details block so the
 * main reading flow stays clean. Empty / abandoned messages are skipped.
 */
function buildChatMarkdown({
  modelId,
  agentName,
  sessionTitle,
  projectName,
  messages,
  inputText,
  attachments,
  used,
  limit,
  pct,
}: {
  modelId: string;
  agentName: string;
  sessionTitle: string;
  projectName: string;
  messages: MessageLike[];
  inputText: string;
  attachments: ReturnType<typeof useAttachmentsStore.getState>["items"];
  used: number;
  limit: number;
  pct: number;
}): string {
  const stamp = new Date().toISOString();
  const lines: string[] = [
    `# ${sessionTitle}`,
    ``,
    `_${projectName} · ${stamp}_`,
    ``,
    `| Field | Value |`,
    `| --- | --- |`,
    `| Model | \`${modelId}\` |`,
    `| Agent | ${agentName} |`,
    `| Context | ~${formatTokens(used)} / ${formatTokens(limit)} (${pct.toFixed(1)}%) |`,
    `| Messages | ${messages.length} |`,
    ``,
    `---`,
    ``,
    `## Conversation`,
    ``,
  ];

  if (messages.length === 0) {
    lines.push(`_No messages in this session yet._`, ``);
  } else {
    for (const m of messages) {
      const heading =
        m.role === "user" ? "### You" : m.role === "assistant" ? "### Assistant" : "### Tool";
      const ts = m.timestamp ? ` _(${m.timestamp})_` : "";
      lines.push(`${heading}${ts}`, ``);
      const body = m.content.trim();
      lines.push(body.length > 0 ? body : `_(empty message)_`, ``);
      if (m.thinkingContent && m.thinkingContent.trim().length > 0) {
        lines.push(
          `<details><summary>Thinking</summary>`,
          ``,
          `\`\`\``,
          m.thinkingContent.trim(),
          `\`\`\``,
          ``,
          `</details>`,
          ``,
        );
      }
      if (m.attachments && m.attachments.length > 0) {
        lines.push(
          `> Attached: ${m.attachments.map((a) => `\`${a.name}\``).join(", ")}`,
          ``,
        );
      }
    }
  }

  lines.push(`---`, ``, `## Staged prompt`, ``);
  lines.push(inputText.trim() || `_(none)_`, ``);

  lines.push(`## Staged attachments`, ``);
  if (attachments.length === 0) {
    lines.push(`_(none)_`, ``);
  } else {
    for (const a of attachments) {
      lines.push(
        `- **${a.kind}** \`${a.name}\` (~${formatTokens(a.approxTokens)} tokens)`,
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}
