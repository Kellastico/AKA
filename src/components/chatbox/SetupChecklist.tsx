import { CheckCircle, Circle, Warning } from "@phosphor-icons/react";
import { useChatStore } from "../../stores/use-chat-store";
import { useAgentsStore } from "../../stores/use-agents-store";
import { useProjectsStore } from "../../stores/use-projects-store";
import { useProjectConfigStore } from "../../stores/use-project-config-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";

type Item = { key: string; ok: boolean; label: string; hint: string };

/**
 * Pre-flight checklist shown above the chat box whenever a required piece of
 * the runtime/model/agent setup is missing. The send button is also disabled
 * via the same conditions, but the checklist is what tells the user *why* —
 * users should never be guessing.
 */
export function SetupChecklist() {
  const mode = useChatStore((s) => s.mode);
  const active = useRuntimeStore((s) => s.active);
  const healthy = useRuntimeStore((s) => s.healthy);
  const selectedModelId = useRuntimeStore((s) => s.selectedModelId);
  const agent = useAgentsStore((s) =>
    s.agents.find((a) => a.id === s.selectedAgentId),
  );
  const activeProject = useProjectsStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  const projectAgentBin = useProjectConfigStore(
    (s) => s.config?.agent.bin ?? "",
  );

  const projectOk = !!activeProject;
  const runtimeOk = !!active && healthy;
  const modelOk = !!selectedModelId;
  // Agent mode needs a binary to spawn; for ask/edit, just having one selected
  // is enough. The `installed` PATH-detection flag is ADVISORY only — the
  // backend resolves the bin via the login shell at launch — so a registered
  // agent with a bin is "ready" even if probing missed it on PATH.
  const agentSelected = !!agent;
  const agentReady =
    mode === "agent" ? agentSelected && !!agent.bin.trim() : agentSelected;
  // The agent picker has a selection, but the *project* config is still empty
  // — this is the case that previously produced the "agent.bin is not
  // configured" backend crash. switchProject auto-heals legacy projects on
  // activation, so seeing this row means either heal hadn't run yet or the
  // user genuinely has no global agent picked.
  const projectAgentBound =
    mode !== "agent" || projectAgentBin.trim().length > 0;

  const items: Item[] = [
    {
      key: "project",
      ok: projectOk,
      label: activeProject
        ? `Project: ${activeProject.name}`
        : "Pick a project folder",
      hint: projectOk
        ? ""
        : "Open the bottom rail and pick a project — the LLM and the agent both scope their work to that folder.",
    },
    {
      key: "runtime",
      ok: runtimeOk,
      label: !active
        ? "Connect a runtime"
        : !healthy
          ? "Runtime is offline"
          : "Runtime online",
      hint: !active
        ? "Open the model picker and pick a runtime (Ollama, LM Studio, …)."
        : !healthy
          ? "Start your local LLM server, then it'll reconnect automatically."
          : "",
    },
    {
      key: "model",
      ok: modelOk,
      label: selectedModelId ? `Model: ${selectedModelId}` : "Select a model",
      hint: modelOk
        ? ""
        : "Open the model picker to choose which LLM should answer.",
    },
    {
      key: "agent",
      ok: agentReady,
      label: !agentSelected
        ? "Pick an agent"
        : mode === "agent" && !agent!.installed
          ? `Agent: ${agent!.name} (not detected on PATH)`
          : `Agent: ${agent!.name}`,
      hint: !agentSelected
        ? "Open the agent picker and register the agent you use."
        : mode === "agent" && !agent!.installed
          ? "AKA couldn't find this on your PATH, but it'll resolve the binary via your login shell at launch. If it's genuinely missing, the run will say so."
          : "",
    },
  ];

  // The project-agent row is only meaningful in agent mode and only once a
  // project is selected — for the other modes the backend never reads
  // agent.bin, and the existing "Pick a project folder" row already covers
  // the no-project case. Only push it when it can actually flag a real
  // problem, otherwise it just adds a confusing always-green row.
  if (mode === "agent" && projectOk) {
    items.push({
      key: "project-agent",
      ok: projectAgentBound,
      label: projectAgentBound
        ? "Project is configured for an agent"
        : "This project has no agent saved",
      hint: projectAgentBound
        ? ""
        : "Pick (or re-pick) an agent from the picker above — the selection is written to this project's .äkä/config.json. Until then the backend would crash with 'agent.bin is not configured'.",
    });
  }

  const missing = items.filter((i) => !i.ok);
  if (missing.length === 0) return null;

  return (
    <div className="mb-1.5 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-amber-100">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium">
        <Warning size={13} weight="fill" />
        <span>Finish setup to start a session</span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map((i) => (
          <div key={i.key} className="flex items-start gap-2 text-[11px] leading-snug">
            {i.ok ? (
              <CheckCircle
                size={12}
                weight="fill"
                className="mt-0.5 shrink-0 text-emerald-300"
              />
            ) : (
              <Circle size={12} className="mt-0.5 shrink-0 text-amber-200" />
            )}
            <div className="flex flex-col">
              <span className={i.ok ? "text-white/55" : "text-amber-100/95"}>
                {i.label}
              </span>
              {!i.ok && i.hint && (
                <span className="text-[10px] text-amber-100/60">{i.hint}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
