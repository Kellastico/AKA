import type { ErrorFix } from "./error-fixes";
import { useAskUserStore } from "../stores/use-ask-user-store";
import { useShellRunnerStore } from "../stores/use-shell-runner-store";
import { useProjectsStore } from "../stores/use-projects-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";
import { useWorkspaceStore } from "../stores/use-workspace-store";

/**
 * Run an auto-fix end-to-end:
 *
 *   1. Confirm with the user via the bottom-sheet (`askUser`), showing
 *      *exactly* what commands will run — never silently mutate their system.
 *   2. Make sure the Console pane is open so they can watch the streaming
 *      output. If it isn't, spawn one.
 *   3. Dispatch the joined command (`a && b && c`) to the existing shell
 *      runner — that's already wired to surface stdout/stderr and exit code.
 *
 * Returns true if the user confirmed and the fix was dispatched; false if
 * they cancelled or there's no project context.
 */
export async function runAutoFix(fix: ErrorFix): Promise<boolean> {
  const ps = useProjectsStore.getState();
  const projectPath =
    ps.projects.find((p) => p.id === ps.activeProjectId)?.path ?? null;

  if (!projectPath) {
    useRuntimeStore.getState().pushToast({
      kind: "error",
      text: "Open a project before running auto-fix.",
    });
    return false;
  }

  // Confirmation sheet — show the user the actual commands. This is the
  // promise-based askUser API; resolves with the selected value(s).
  const requiresLine = fix.requires
    ? `\n\nRequires: ${fix.requires}`
    : "";
  const cmdList = fix.commands.map((c) => `  • ${c}`).join("\n");

  const [picked] = await useAskUserStore.getState().askUser({
    question: fix.title,
    detail: `${fix.description}${requiresLine}\n\nCommands:\n${cmdList}`,
    options: [
      {
        value: "run",
        label: "Run the fix",
        description: "Executes the commands above in the Console",
      },
      {
        value: "cancel",
        label: "Cancel",
        description: "Don't run anything",
      },
    ],
    confirmLabel: "Run fix",
    cancelLabel: "Cancel",
  });

  if (picked !== "run") return false;

  // Open the Console pane (if not already) so the user sees the output.
  const ws = useWorkspaceStore.getState();
  if (!ws.extraPanes.some((p) => p.type === "console")) {
    ws.openPane("console");
  }

  // && short-circuits on the first failure — if `brew install` fails, we
  // don't waste time on `pip3 install`.
  const joined = fix.commands.join(" && ");
  await useShellRunnerStore.getState().run(projectPath, joined);
  return true;
}
