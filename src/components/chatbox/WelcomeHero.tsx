import { useMemo } from "react";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { useAgentsStore } from "../../stores/use-agents-store";

const PROMPTS = [
  "How can I help you build today?",
  "What are we building today?",
  "What should we ship today?",
  "What's next on the build list?",
  "Ready to make something?",
];

export function WelcomeHero({ compact = false }: { compact?: boolean }) {
  const prompt = useMemo(
    () => PROMPTS[Math.floor(Math.random() * PROMPTS.length)],
    []
  );
  const selectedModelId = useRuntimeStore((s) => s.selectedModelId);
  const agents = useAgentsStore((s) => s.agents);
  const selectedAgentId = useAgentsStore((s) => s.selectedAgentId);
  const agentName = agents.find((a) => a.id === selectedAgentId)?.name;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <h1
        className={[
          "text-center font-display font-medium tracking-tight text-[#FDE9A6]/60",
          compact ? "text-lg" : "text-3xl sm:text-4xl",
        ].join(" ")}
      >
        {prompt}
      </h1>
      {(selectedModelId || agentName) && (
        <div className="flex items-center gap-2">
          {selectedModelId && (
            <span className="rounded-full bg-white/8 px-3 py-1 text-xs text-ink/50">
              {selectedModelId}
            </span>
          )}
          {agentName && (
            <span className="rounded-full bg-white/8 px-3 py-1 text-xs text-ink/50">
              {agentName}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
