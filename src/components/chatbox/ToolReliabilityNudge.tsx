import { Info, X } from "@phosphor-icons/react";
import { useChatStore, type ChatMode } from "../../stores/use-chat-store";
import {
  isBuiltinLoopAgent,
  useAgentsStore,
  type Agent,
} from "../../stores/use-agents-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { usePrefsStore } from "../../stores/use-prefs-store";
import { classifyModel } from "../../lib/model-posture";

/**
 * Whether the tool-reliability advisory applies: the built-in **Execute** loop
 * (None agent) is selected AND the chosen model does not advertise native
 * tool-calling, so the loop must drive it through the text-protocol fallback.
 * Pure so the gating is unit-testable without mounting the component.
 */
export function shouldNudgeToolReliability(args: {
  mode: ChatMode;
  agent: Agent | null | undefined;
  modelId: string | null | undefined;
  suppressed: boolean;
}): boolean {
  const { mode, agent, modelId, suppressed } = args;
  if (suppressed) return false;
  if (mode !== "agent" || !isBuiltinLoopAgent(agent)) return false;
  if (!modelId) return false;
  return !classifyModel(modelId).nativeToolCalling;
}

/**
 * Advisory shown for **Execute + None** when the selected model does not
 * advertise native tool-calling. In that case AKA drives it through the
 * text-protocol fallback, which is less reliable for multi-step tool use (a
 * local model can return an empty step; v1.5.1 retries those, but a
 * tool-calling model is steadier).
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
  const suppressed = usePrefsStore((s) => s.suppressToolReliabilityNudge);
  const suppress = usePrefsStore((s) => s.setSuppressToolReliabilityNudge);

  if (!shouldNudgeToolReliability({ mode, agent, modelId, suppressed })) return null;

  return (
    <div className="mb-1.5 flex items-start gap-2 rounded-xl border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-sky-100">
      <Info size={13} weight="fill" className="mt-0.5 shrink-0 text-sky-300" />
      <div className="flex-1 text-[11px] leading-snug">
        <span className="font-medium">{modelId}</span> doesn't advertise native
        tool-calling, so Execute drives it through AKA's text-based tool
        protocol. That works, but it's less reliable for multi-step edits and
        shell commands — a model with native tool-calling support tends to run
        the loop more steadily.
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
