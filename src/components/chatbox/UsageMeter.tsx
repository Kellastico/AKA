import { useEffect, useRef, useState } from "react";
import { CaretDown, BookOpenText, FileText, Warning } from "@phosphor-icons/react";
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
import {
  writeTextFile,
  getMemoryUsage,
  getHardwareStats,
  setContextSize,
  setReasoning,
  inspectModel,
  inspectOllamaModel,
  type MemoryUsage,
  type HardwareStats,
  type ModelSpec,
} from "../../lib/tauri/commands";
import { Sparkline } from "./Sparkline";
import {
  CONTEXT_STEP,
  MIN_CONTEXT,
  estimateContext,
  formatContextSize,
  maxContextFor,
} from "./context-size";
import { useRuntimeStore as useRuntimeStoreForHardware } from "../../features/01-llm-provider/use-runtime-store";

function formatGB(gb: number) {
  if (gb < 1) return `${(gb * 1024).toFixed(0)} MB`;
  return `${gb.toFixed(2)} GB`;
}

/** A 0-100 reading, or a dash when the host couldn't read it. */
function formatPercent(v: number | null | undefined) {
  return v === null || v === undefined ? "—" : `${Math.round(v)}%`;
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
  void agent;

  // Price the model that is *selected*, not only one that happens to be
  // loaded. Picking a model in the chat box doesn't load it — the runtime only
  // loads on the first message — so without this the panel stays blank through
  // exactly the window in which someone is deciding what to run.
  const [spec, setSpec] = useState<ModelSpec | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSpec(null);
    // Built-in models are addressed by filename minus the extension; Ollama's
    // are read from its own blob store. Either way the shape comes from the
    // model's GGUF header, so the figures shown are the model's real ones.
    void inspectModel(`${modelId}.gguf`)
      .then((s) => (s ? s : inspectOllamaModel(modelId)))
      .then((s) => {
        if (!cancelled) setSpec(s);
      })
      .catch(() => {
        /* runtime AKA can't see the weights for — leave unknown */
      });
    return () => {
      cancelled = true;
    };
  }, [modelId]);

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

  // Hardware readings poll on their own 1 s cadence. This is a pure read of a
  // window the host fills in the background, so the rate here can't affect the
  // CPU delta. Null while no model is loaded — every row falls back to a dash.
  const [hw, setHw] = useState<HardwareStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const result = await getHardwareStats().catch(() => null);
      if (!cancelled) setHw(result);
    };
    void read();
    const id = setInterval(() => void read(), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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
        {hw?.current.runtimeMemoryMb != null && (
          <StatRow
            label="  Runtime"
            value={formatGB(hw.current.runtimeMemoryMb / 1024)}
            subtle
          />
        )}
      </div>
      {mem?.ctxSize != null && mem.ctxSize > 0 ? (
        <>
          <div className="-mx-2 h-px bg-white/10" />
          <ContextSizeControl mem={mem} spec={spec} />
        </>
      ) : spec ? (
        <>
          <div className="-mx-2 h-px bg-white/10" />
          <ContextSizeReadOnly spec={spec} />
        </>
      ) : null}
      {/* Both halves must hold: the model's template has the switch, and the
          runtime serving it can flip it. Only the built-in runtime can, and
          only its readings carry `reasoning` — so an Ollama model with the
          same template gets no toggle rather than one that does nothing. */}
      {spec?.supportsReasoningToggle && mem?.reasoning != null ? (
        <>
          <div className="-mx-2 h-px bg-white/10" />
          <ReasoningControl mem={mem} />
        </>
      ) : null}
      <div className="-mx-2 h-px bg-white/10" />
      <div className="space-y-1.5 px-3 py-3">
        <StatRow label="CPU" value={formatPercent(hw?.current.cpuPercent)} />
        {hw && (
          <>
            <StatRow
              label="  AKA"
              value={formatPercent(hw.current.appCpuPercent)}
              subtle
            />
            <StatRow
              label="  Runtime"
              value={formatPercent(hw.current.runtimeCpuPercent)}
              subtle
            />
            <Sparkline
              className="text-white/30"
              points={hw.recent.map((r) => ({
                atMs: r.atMs,
                value: r.cpuPercent,
              }))}
            />
          </>
        )}
        <StatRow label="GPU" value={formatPercent(hw?.current.gpuPercent)} />
        {hw?.current.gpuMemoryMb != null && (
          <StatRow
            label="  Memory"
            value={formatGB(hw.current.gpuMemoryMb / 1024)}
            subtle
          />
        )}
        {hw && hw.current.gpuPercent != null && (
          <Sparkline
            className="text-white/30"
            points={hw.recent
              .filter((r) => r.gpuPercent != null)
              .map((r) => ({ atMs: r.atMs, value: r.gpuPercent as number }))}
          />
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

/**
 * Set the runtime's context window, with the memory cost stated plainly.
 *
 * The slider's range comes from the model itself — its trained context window,
 * read from the GGUF metadata by the runtime — rather than a fixed ladder of
 * sizes, so a 4k model never offers 128k and a 262k model is never capped at
 * 32k. The memory figure is likewise computed from the model's own
 * architecture, not estimated.
 *
 * Warnings never block the choice: it is the user's machine, and only they
 * know what they are willing to risk on it.
 */
function ContextSizeControl({
  mem,
  spec,
}: {
  mem: MemoryUsage;
  /** The selected model's shape, read from its header. Null for external
   *  runtimes, where no local file exists to inspect. */
  spec: ModelSpec | null;
}) {
  const hardware = useRuntimeStoreForHardware((s) => s.hardware);
  const current = mem.ctxSize ?? 0;
  // Prefer the selected model's own figures. Falling back to the loaded
  // model's would price the wrong model the moment the two differ — which is
  // every moment between picking a model and sending the first message.
  const nCtxTrain = spec?.nCtxTrain ?? mem.nCtxTrain;
  const kvBytesPerToken = spec?.kvBytesPerToken ?? mem.kvBytesPerToken;
  const modelMb = spec ? spec.sizeBytes / (1024 * 1024) : mem.modelMb;
  const maxFittingCtx = spec?.maxFittingCtx ?? mem.maxFittingCtx;
  const max = maxContextFor(nCtxTrain, current);

  // Track the drag locally so the slider stays responsive: the runtime applies
  // the value on the next message and /metrics won't echo it back for seconds.
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? current;

  useEffect(() => {
    if (draft !== null && current === draft) setDraft(null);
  }, [current, draft]);

  const estimate = estimateContext({
    ctxSize: shown,
    kvBytesPerToken,
    modelMb,
    totalRamGb: hardware?.totalRamGb,
    maxFittingCtx,
  });

  const commit = async (size: number) => {
    setDraft(size);
    try {
      await setContextSize(size);
    } catch (err) {
      setDraft(null);
      // Tauri rejects with a plain string, not an Error — an `instanceof`
      // check alone silently swallows the reason and leaves the user with
      // "it failed" and nothing to act on.
      const reason =
        err instanceof Error ? err.message : String(err ?? "").trim();
      useRuntimeStore.getState().pushToast({
        kind: "error",
        text: reason
          ? `Couldn't set context size — ${reason}`
          : "Couldn't set context size (no reason given by the runtime).",
      });
    }
  };

  const tone =
    estimate?.risk === "over"
      ? "text-red-400"
      : estimate?.risk === "tight"
        ? "text-amber-400"
        : "text-white/45";

  return (
    <div className="px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-white/60">Context size</span>
        <span className="tabular-nums text-white/90">
          {shown.toLocaleString()} tokens
        </span>
      </div>

      <input
        type="range"
        min={MIN_CONTEXT}
        max={max}
        step={CONTEXT_STEP}
        value={Math.min(shown, max)}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={(e) => void commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => void commit(Number(e.currentTarget.value))}
        aria-label="Context size in tokens"
        style={{
          // Drives the amber rail-fill in styles.css (.aka-slider track).
          ["--pct" as string]: `${((Math.min(shown, max) - MIN_CONTEXT) / Math.max(max - MIN_CONTEXT, 1)) * 100}%`,
        }}
        className="aka-slider mt-2"
      />

      <div className="flex justify-between text-[9px] uppercase tracking-wide text-white/35">
        <span>{formatContextSize(MIN_CONTEXT)}</span>
        {estimate?.safeMax && estimate.safeMax < max ? (
          <span className="text-amber-400/70">
            fits here · {formatContextSize(estimate.safeMax)}
          </span>
        ) : null}
        <span>
          {nCtxTrain ? "model max" : "current"} · {formatContextSize(max)}
        </span>
      </div>

      {estimate && (
        <p className={["mt-2 text-[11px] leading-relaxed", tone].join(" ")}>
          {estimate.risk !== "ok" && (
            <Warning size={11} weight="fill" className="mr-1 inline shrink-0" />
          )}
          {estimate.warning ??
            `About ${estimate.totalGb < 10 ? estimate.totalGb.toFixed(1) : Math.round(estimate.totalGb)} GB with weights — roughly ${Math.round(estimate.ramFraction * 100)}% of this machine's RAM.`}
        </p>
      )}
      <p className="mt-1.5 text-[10px] text-white/30">
        Applies from your next message.
      </p>
    </div>
  );
}

/**
 * Turn the model's reasoning step on or off.
 *
 * Rendered only for models whose chat template carries an `enable_thinking`
 * switch — reasoning is a minority feature, and a control that appeared
 * everywhere would silently do nothing on the models that have no reasoning
 * step at all.
 */
function ReasoningControl({ mem }: { mem: MemoryUsage }) {
  const current = mem.reasoning ?? true;
  const [pending, setPending] = useState<boolean | null>(null);
  const shown = pending ?? current;

  useEffect(() => {
    if (pending !== null && current === pending) setPending(null);
  }, [current, pending]);

  const toggle = async () => {
    const next = !shown;
    setPending(next);
    try {
      await setReasoning(next);
    } catch (err) {
      setPending(null);
      const reason =
        err instanceof Error ? err.message : String(err ?? "").trim();
      useRuntimeStore.getState().pushToast({
        kind: "error",
        text: reason
          ? `Couldn't change reasoning — ${reason}`
          : "Couldn't change reasoning.",
      });
    }
  };

  return (
    <div className="px-3 py-3">
      <button
        onClick={() => void toggle()}
        role="switch"
        aria-checked={shown}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-white/60">Reasoning</span>
        <span
          className={[
            "relative h-4 w-7 shrink-0 rounded-full transition-colors",
            shown ? "bg-amber-400/80" : "bg-white/15",
          ].join(" ")}
        >
          <span
            className={[
              "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform",
              shown ? "translate-x-3.5" : "translate-x-0.5",
            ].join(" ")}
          />
        </span>
      </button>
      <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">
        {shown
          ? "The model thinks before answering — slower, usually better on hard problems."
          : "The model answers directly, skipping the thinking step."}{" "}
        Applies from your next message.
      </p>
    </div>
  );
}

/**
 * What a context window costs on a runtime AKA cannot set it on.
 *
 * Every figure here is read from the model's own GGUF header, so it is as true
 * as the built-in runtime's. What is missing is the control, and deliberately
 * so: AKA speaks the OpenAI-compatible API, and Ollama's compatibility layer
 * ignores `num_ctx` — a request carrying it still loads at the server's own
 * default. A slider here would move and change nothing, so there isn't one.
 */
function ContextSizeReadOnly({ spec }: { spec: ModelSpec }) {
  const hardware = useRuntimeStoreForHardware((s) => s.hardware);
  const estimate = estimateContext({
    ctxSize: spec.maxFittingCtx,
    kvBytesPerToken: spec.kvBytesPerToken,
    modelMb: spec.sizeBytes / (1024 * 1024),
    totalRamGb: hardware?.totalRamGb,
    maxFittingCtx: spec.maxFittingCtx,
  });

  return (
    <div className="px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-white/60">Model max context</span>
        <span className="tabular-nums text-white/90">
          {spec.nCtxTrain.toLocaleString()} tokens
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-white/45">Fits this machine</span>
        <span className="tabular-nums text-white/70">
          {spec.maxFittingCtx.toLocaleString()} tokens
        </span>
      </div>
      {estimate && spec.maxFittingCtx < spec.nCtxTrain ? (
        <p className="mt-2 text-[11px] leading-relaxed text-amber-400/80">
          <Warning size={11} weight="fill" className="mr-1 inline shrink-0" />
          This model is trained for more context than this machine can hold.
        </p>
      ) : null}
      <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">
        This runtime&rsquo;s context size is set in the runtime itself — the
        OpenAI-compatible API AKA talks to it through has no way to change
        it.
      </p>
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
