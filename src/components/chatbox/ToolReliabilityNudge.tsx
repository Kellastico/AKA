import { useEffect } from "react";
import { Info, X } from "@phosphor-icons/react";
import { useChatStore, type ChatMode } from "../../stores/use-chat-store";
import {
  isBuiltinLoopAgent,
  useAgentsStore,
  type Agent,
} from "../../stores/use-agents-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { usePrefsStore } from "../../stores/use-prefs-store";
import { supportKey, useToolSupportStore } from "../../stores/use-tool-support-store";
import type { ToolTransport } from "../../lib/builtin-loop";

/**
 * Whether the tool-reliability advisory applies: the built-in **Execute** loop
 * (None agent) is selected AND the EVIDENCE says this (runtime, model) pair
 * runs on the text-protocol fallback — either the runtime advertised no
 * `tools` capability, or a run this session was rejected natively and fell
 * back. No model-name heuristics: `undefined` transport (nothing known yet)
 * shows nothing, because the adaptive loop will try native first anyway.
 * Pure so the gating is unit-testable without mounting the component.
 */
export function shouldNudgeToolReliability(args: {
  mode: ChatMode;
  agent: Agent | null | undefined;
  modelId: string | null | undefined;
  transport: ToolTransport | undefined;
  suppressed: boolean;
}): boolean {
  const { mode, agent, modelId, transport, suppressed } = args;
  if (suppressed) return false;
  if (mode !== "agent" || !isBuiltinLoopAgent(agent)) return false;
  if (!modelId) return false;
  return transport === "text";
}

/**
 * Advisory shown for **Execute + None** when the selected model is KNOWN to
 * run on the text-protocol fallback (runtime-reported, or observed this
 * session). That path works, but it's less reliable for multi-step tool use —
 * a tool-calling model runs the loop more steadily.
 *
 * Deliberately agnostic — it states the capability *fact* about the user's own
 * selected model and never names or prescribes a specific replacement (AKA
 * doesn't pick models for you). Purely informational: it never blocks a run,
 * and one dismiss silences it for good (persisted via prefs).
 */
export function ToolReliabilityNudge() {
  const mode = useChatStore((s) => s.mode);
  const agent = useAgentsStore((s) =>
    s.agents.find((a) => a.id === s.selectedAgentId),
  );
  const modelId = useRuntimeStore((s) => s.selectedModelId);
  const baseUrl = useRuntimeStore((s) => s.active?.baseUrl ?? "");
  const suppressed = usePrefsStore((s) => s.suppressToolReliabilityNudge);
  const suppress = usePrefsStore((s) => s.setSuppressToolReliabilityNudge);
  const transport = useToolSupportStore((s) =>
    modelId ? s.known[supportKey(baseUrl, modelId)] : undefined,
  );
  const ensureProbe = useToolSupportStore((s) => s.ensureProbe);

  // Ask the runtime about the selected model as soon as it's picked (cheap,
  // once per pair) so the advisory can be accurate BEFORE the first run.
  useEffect(() => {
    if (baseUrl && modelId) void ensureProbe(baseUrl, modelId);
  }, [baseUrl, modelId, ensureProbe]);

  if (!shouldNudgeToolReliability({ mode, agent, modelId, transport, suppressed })) {
    return null;
  }

  return (
    <div className="mb-1.5 flex items-start gap-2 rounded-xl border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-sky-100">
      <Info size={13} weight="fill" className="mt-0.5 shrink-0 text-sky-300" />
      <div className="flex-1 text-[11px] leading-snug">
        <span className="font-medium">{modelId}</span> doesn't support native
        tool-calling on this runtime, so Execute drives it through AKA's
        text-based tool protocol. That works, but it's less reliable for
        multi-step edits and shell commands — a model with native tool-calling
        support tends to run the loop more steadily.
      </div>
      <button
        onClick={() => void suppress(true)}
        aria-label="Dismiss and don't show again"
        title="Dismiss — don't show again"
        className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-sky-200/60 transition-colors hover:bg-white/10 hover:text-sky-100"
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}
