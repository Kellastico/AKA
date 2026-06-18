import { useEffect, useState } from "react";
import { Wrench } from "@phosphor-icons/react";
import { toolManifest, type ToolManifest } from "../../lib/tauri/commands";
import { useProjectConfigStore } from "../../stores/use-project-config-store";
import { Tooltip } from "../Tooltip";

/**
 * Read-only indicator of AKA's built-in tool pantry for the active project: how
 * many tools AKA advertises to the agent this run, and how many the agent's own
 * tools override (shadow). Surfaces the otherwise-invisible overridable layer so
 * a swapped-in tool that behaves differently doesn't become a silent change
 * (architecture → Observability: "surfaces shadowed defaults").
 *
 * Hidden when there's no project, the pantry is disabled, or there's nothing to
 * report. Counts come from the `tool_manifest` command; outside Tauri (browser
 * dev) that resolves to an empty manifest, so the indicator simply stays hidden.
 */
export function ToolsIndicator({ compact }: { compact: boolean }) {
  const projectPath = useProjectConfigStore((s) => s.projectPath);
  // Depend on the tools-relevant config slices only, so the manifest re-fetches
  // when the user edits mode / enabled / the agent's declared tools — but not on
  // every unrelated config write (model/session churn).
  const toolsMode = useProjectConfigStore((s) => s.config?.tools.mode);
  const toolsEnabled = useProjectConfigStore((s) => s.config?.tools.enabled);
  const providesKey = useProjectConfigStore((s) =>
    (s.config?.agent.provides_tools ?? []).join(","),
  );

  const [manifest, setManifest] = useState<ToolManifest | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectPath) {
      setManifest(null);
      return;
    }
    void toolManifest(projectPath)
      .then((m) => {
        if (!cancelled) setManifest(m);
      })
      .catch(() => {
        if (!cancelled) setManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, toolsMode, toolsEnabled, providesKey]);

  if (!projectPath || !manifest || !manifest.enabled) return null;
  const advertised = manifest.tools.length;
  const overridden = manifest.shadowed.length;
  if (advertised === 0 && overridden === 0) return null;

  const plural = (n: number) => (n === 1 ? "" : "s");
  const label =
    overridden > 0
      ? `${advertised} AKA tool${plural(advertised)} · ${overridden} overridden`
      : `${advertised} AKA tool${plural(advertised)}`;

  const advList = manifest.tools.map((t) => t.name).join(", ") || "none";
  const tip =
    `AKA advertises (${manifest.mode}): ${advList}` +
    (overridden > 0
      ? ` — your agent overrides: ${manifest.shadowed.join(", ")}`
      : "");

  return (
    <Tooltip label={tip}>
      <div
        className={[
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 text-white/55",
          compact ? "text-[10px]" : "text-[11px]",
        ].join(" ")}
      >
        <Wrench size={compact ? 11 : 12} weight="regular" />
        <span className="whitespace-nowrap">{label}</span>
      </div>
    </Tooltip>
  );
}
