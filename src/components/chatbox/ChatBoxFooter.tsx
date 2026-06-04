import { ArrowUp, Pause, Play, Stop } from "@phosphor-icons/react";
import { ModelPicker } from "./ModelPicker";
import { AgentPicker } from "./AgentPicker";
import { ModePicker } from "./ModePicker";
import { AttachButton } from "./AttachButton";
import {
  useActiveSessionRunState,
  useChatStore,
} from "../../stores/use-chat-store";
import { useAttachmentsStore } from "../../stores/use-attachments-store";
import { useAgentsStore } from "../../stores/use-agents-store";
import { useProjectsStore } from "../../stores/use-projects-store";
import { useProjectConfigStore } from "../../stores/use-project-config-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { useTokenCounterStore } from "../../stores/use-token-counter-store";
import { Tooltip } from "../Tooltip";
import { ConcurrencyRamWarningModal } from "../ConcurrencyRamWarningModal";

export function ChatBoxFooter({ compact }: { compact: boolean }) {
  const runs = useChatStore((s) => s.runs);
  const mode = useChatStore((s) => s.mode);
  const submit = useChatStore((s) => s.submit);
  const stop = useChatStore((s) => s.stop);
  const pause = useChatStore((s) => s.pause);
  const resume = useChatStore((s) => s.resume);
  const runState = useActiveSessionRunState();
  const pendingRamWarn = useChatStore((s) => s.pendingRamWarn);
  const dismissRamWarn = useChatStore((s) => s.dismissRamWarn);
  const inputText = useChatStore((s) => s.inputText);
  // Subscribed (not getState) so the Send button re-enables the moment a chip
  // is added/removed — lets an image be sent with no accompanying text.
  const hasAttachments = useAttachmentsStore((s) => s.items.length > 0);
  const runtimeActive = useRuntimeStore((s) => !!s.active);
  const runtimeHealthy = useRuntimeStore((s) => s.healthy);
  const selectedModelId = useRuntimeStore((s) => s.selectedModelId);
  const agent = useAgentsStore((s) =>
    s.agents.find((a) => a.id === s.selectedAgentId),
  );
  const projectSelected = useProjectsStore(
    (s) => s.activeProjectId !== null,
  );
  const activeSessionId = useProjectsStore((s) => s.activeSessionId);
  // A run belongs to the session that launched it. Only the launching session
  // shows the Stop control. A run in *another* session no longer blocks this
  // one — concurrent sessions are allowed; handleSend's policy gate is what
  // guards memory-limited machines.
  const thisSessionRunning = activeSessionId ? !!runs[activeSessionId] : false;
  const projectAgentBin = useProjectConfigStore(
    (s) => s.config?.agent.bin ?? "",
  );
  const contextOverflow = useTokenCounterStore((s) => s.status === "over");

  const needsAgentInstalled = mode === "agent";
  const agentReady = !!agent && (!needsAgentInstalled || agent.installed);
  // In agent mode the backend reads `.äkä/config.json` and refuses to spawn
  // when agent.bin is empty. Disable Send (instead of letting it crash) so
  // the user sees the SetupChecklist row and re-picks an agent — selecting
  // one from the picker mirrors into the project config.
  const projectAgentBound =
    mode !== "agent" || projectAgentBin.trim().length > 0;

  const canSend =
    (inputText.trim().length > 0 || hasAttachments) &&
    projectSelected &&
    runtimeActive &&
    runtimeHealthy &&
    !!selectedModelId &&
    agentReady &&
    projectAgentBound &&
    !contextOverflow;

  const sendLabel = !projectSelected
    ? "Pick a project folder first"
    : !runtimeActive
      ? "Connect a runtime first"
      : !runtimeHealthy
        ? "Runtime offline"
        : !selectedModelId
          ? "Select a model"
          : contextOverflow
            ? "Context limit reached. Swap your model or start a new session."
            : !agent
              ? "Pick an agent"
              : needsAgentInstalled && !agent.installed
                ? `${agent.name} isn't installed`
                : !projectAgentBound
                  ? "Re-pick the agent — this project's config is empty"
                  : "Send";

  return (
    <>
    <div className="flex items-center gap-1.5 pt-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ModelPicker compact={compact} />
        <AgentPicker compact={compact} />
        <ModePicker compact={compact} />
        <AttachButton compact={compact} />
      </div>
      {thisSessionRunning ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {runState === "paused" ? (
            <Tooltip label="Resume">
              <button
                onClick={() => resume()}
                aria-label="Resume"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-emerald-400/50 bg-emerald-500/15 text-emerald-200 transition-colors hover:bg-emerald-500/25"
              >
                <Play size={compact ? 12 : 14} weight="fill" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Pause">
              <button
                onClick={() => pause()}
                aria-label="Pause"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/75 transition-colors hover:bg-white/10"
              >
                <Pause size={compact ? 12 : 14} weight="fill" />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Stop">
            <button
              onClick={() => stop()}
              aria-label="Stop"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600"
            >
              <Stop size={compact ? 12 : 14} weight="fill" />
            </button>
          </Tooltip>
        </div>
      ) : (
        <Tooltip label={sendLabel}>
          <button
            onClick={() => submit()}
            disabled={!canSend}
            aria-label={sendLabel}
            className={[
              "inline-flex shrink-0 items-center justify-center rounded-full transition-all",
              canSend
                ? "border border-blue-400/50 bg-blue-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_12px_rgba(59,130,246,0.35)] hover:bg-blue-400 active:scale-[0.97]"
                : "border border-white/10 bg-white/5 text-white/30 cursor-not-allowed",
              "h-10 w-10",
            ].join(" ")}
          >
            <ArrowUp size={compact ? 14 : 16} weight="bold" />
          </button>
        </Tooltip>
      )}
    </div>
    <ConcurrencyRamWarningModal
      open={!!pendingRamWarn}
      runningModels={pendingRamWarn?.runningModels ?? []}
      incomingModelId={pendingRamWarn?.incomingModelId ?? null}
      onConfirm={() => submit({ force: true })}
      onCancel={dismissRamWarn}
    />
    </>
  );
}
