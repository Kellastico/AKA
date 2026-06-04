import { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { Workspace } from "./components/Workspace";
import { BottomBar } from "./components/BottomBar";
import { FileFinder } from "./components/FileFinder";
import { PermissionRequestModal } from "./components/PermissionRequestModal";
import { FolderPermissionModal } from "./components/FolderPermissionModal";
import { AskUserSheet } from "./components/AskUserSheet";
import { FirstRunOverlay } from "./components/first-run/FirstRunOverlay";
import { useAskUserStore } from "./stores/use-ask-user-store";
import { useFirstRunStore } from "./stores/use-first-run-store";
import { useBootstrapRuntime } from "./features/01-llm-provider/ConnectionPanel";
import { RuntimeToasts } from "./features/01-llm-provider/RuntimeToasts";
import { ModelBrowser } from "./features/01-llm-provider/ModelBrowser";
import { useAgentsStore } from "./stores/use-agents-store";
import { useCustomAgentsStore } from "./stores/use-custom-agents-store";
import { usePrefsStore } from "./stores/use-prefs-store";
import { useChatStore } from "./stores/use-chat-store";
import { useProjectConfigStore } from "./stores/use-project-config-store";
import { useMessagesStore } from "./stores/use-messages-store";
import { useProjectsStore } from "./stores/use-projects-store";
import { useWorkspaceStore } from "./stores/use-workspace-store";
import { useDevServerStore } from "./stores/use-dev-server-store";
import { useShellRunnerStore } from "./stores/use-shell-runner-store";
import { useRuntimeStore } from "./features/01-llm-provider/use-runtime-store";
import { clearSandbox, setSandbox } from "./lib/tauri/commands";
import { useTokenCounterSync } from "./lib/use-token-counter-sync";
import { useSessionMessagesSync } from "./lib/use-session-messages-sync";
import { useDropAttachments } from "./lib/use-drop-attachments";

export function AppShell() {
  useBootstrapRuntime();
  useTokenCounterSync();
  useSessionMessagesSync();
  useDropAttachments();
  const bootstrapAgents = useAgentsStore((s) => s.bootstrap);
  const initCustomAgents = useCustomAgentsStore((s) => s.init);
  const initPrefs = usePrefsStore((s) => s.init);
  useEffect(() => {
    // Restore persisted UI prefs (e.g. "don't show the same-model tip again").
    void initPrefs();
    // Load custom agents from disk first so the very first agent-list
    // reconcile already includes them — avoids a flicker.
    void (async () => {
      await initCustomAgents();
      void bootstrapAgents();
    })();
  }, [bootstrapAgents, initCustomAgents, initPrefs]);

  // Dev hook: expose the askUser API on window so it can be triggered from
  // the browser console or external tooling without prop drilling. Production
  // callers should import useAskUserStore directly.
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __askUser?: unknown }).__askUser =
        useAskUserStore.getState().askUser;
    }
  }, []);

  // The active project drives two pieces of global state:
  //   1. The Rust sandbox boundary (sandbox.project_path is informational
  //      only — the actual boundary is set here from the opened path).
  //   2. The project config store, which then hydrates the runtime/agents/
  //      chat stores. Switching projects always persists the outgoing
  //      project's config before loading the incoming one — see
  //      useProjectConfigStore.switchProject.
  const initProjects = useProjectsStore((s) => s.init);
  const initMessages = useMessagesStore((s) => s.init);
  const initFirstRun = useFirstRunStore((s) => s.init);
  useEffect(() => {
    void (async () => {
      // Load projects first — the first-run heuristic ("any existing
      // projects ⇒ not a first run") depends on that state being hydrated.
      await initProjects();
      void initMessages();
      const hasProjects = useProjectsStore.getState().projects.length > 0;
      await initFirstRun(hasProjects);
    })();
  }, [initProjects, initMessages, initFirstRun]);

  // Dev hook: expose first-run reset on the window so we can re-trigger
  // the wizard during development without nuking the persisted store.
  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __resetFirstRun?: unknown }).__resetFirstRun =
        useFirstRunStore.getState().reset;
    }
  }, []);

  const activeProject = useProjectsStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId) ?? null,
  );
  const switchProject = useProjectConfigStore((s) => s.switchProject);
  const config = useProjectConfigStore((s) => s.config);
  const clearPanes = useWorkspaceStore((s) => s.clearPanes);
  const resetDevServer = useDevServerStore((s) => s.reset);
  const stopShell = useShellRunnerStore((s) => s.stop);

  useEffect(() => {
    if (activeProject?.path) {
      if ("__TAURI_INTERNALS__" in window) {
        setSandbox(activeProject.path).catch((err) =>
          // eslint-disable-next-line no-console
          console.warn("setSandbox failed:", err),
        );
      }
      void switchProject(activeProject.path);
    } else {
      if ("__TAURI_INTERNALS__" in window) {
        clearSandbox().catch(() => {});
      }
      void switchProject(null);
    }
    // Per-project workspace reset. Panes belong to the project they were
    // opened in, so a switch closes them all — the user re-opens whatever
    // they want in the new project. The dev-server singleton is also torn
    // down: any server still running from the previous project is stopped
    // (freeing its port) and the detected URL is cleared so a fresh server
    // in the new project starts from a clean slate. The shell runner is
    // killed too because it was spawned inside the previous project's
    // sandbox — leaving it alive would let it keep reading/writing files
    // outside the new sandbox boundary. In-flight LLM streams and agent
    // runs are intentionally NOT torn down: they finish in the background
    // against their origin session so a misclick doesn't lose work.
    clearPanes();
    void resetDevServer();
    void stopShell();
  }, [activeProject?.path, switchProject, clearPanes, resetDevServer, stopShell]);

  // Granular hydration — split by field so a single-field edit (e.g. the
  // user swaps models, which only touches `config.runtime.model`) doesn't
  // re-fire the heavy runtime+agent+mode hydrate cascade. That cascade is
  // what was causing the screen to flash "No project selected / Aider / Ask"
  // briefly during a swap: the runtime hydrate's awaited HTTP calls and
  // re-set of selectedModelId could land while the disk write was mid-flight,
  // and downstream selectors saw a transient empty/default state.

  // Project-level switch: nukes the runtime if config becomes null.
  useEffect(() => {
    if (!config) {
      void useRuntimeStore.getState().hydrateFromProject(null);
    }
  }, [config === null]);

  // Runtime hydrate — only when base_url or api_key changes. The model
  // field is owned by selectModel directly; re-firing the full hydrate on a
  // model swap would just churn `active` + `selectedModelId` and do two
  // useless HTTP round-trips while the user is mid-swap.
  const runtimeBaseUrl = config?.runtime.base_url;
  const runtimeApiKey = config?.runtime.api_key;
  const runtimeModel = config?.runtime.model;
  useEffect(() => {
    if (!config) return;
    void useRuntimeStore.getState().hydrateFromProject({
      baseUrl: runtimeBaseUrl ?? "",
      model: runtimeModel ?? "",
      apiKey: runtimeApiKey ?? null,
    });
    // The model is intentionally not in the deps — the effect reads its
    // current value but only re-runs when the runtime itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeBaseUrl, runtimeApiKey]);

  // Agent hydrate — only when the agent bin actually changes. We do NOT
  // include `config` in the deps; the agentBin string is sufficient and
  // including the full object re-fires this on every model swap for nothing.
  const agentBin = config?.agent.bin;
  useEffect(() => {
    if (!agentBin) return;
    useAgentsStore.getState().hydrateFromProject(agentBin);
  }, [agentBin]);

  // Mode hydrate — only when the chat mode actually changes.
  const configMode = config?.mode;
  useEffect(() => {
    if (!configMode) return;
    useChatStore.getState().hydrateMode(configMode);
  }, [configMode]);

  // Per-session agent + model restore. When the user switches sessions, look
  // up that session's saved meta and apply it to the pickers. New sessions
  // (no meta) silently inherit the current selection — i.e. "last-used"
  // sticks across the new-session boundary.
  //
  // Backwards-compat: sessions created before sessionMeta existed have no
  // entry. Fall back to scanning the session's own messages for the most
  // recent assistant message's agentId/modelId — those fields have always
  // been written on each chunk. Whatever we recover is then persisted into
  // sessionMeta so the next switch is a fast lookup.
  //
  // Race-safety: depend on `agents` too. At app boot the custom-agents
  // store hydrates asynchronously — if this effect fires first, a session
  // pointing at a custom agent (e.g. LangChain) finds no match in the
  // not-yet-populated agents list and silently bails. Subscribing to the
  // agents array means the effect re-runs the moment custom agents land,
  // and the restore goes through before the user can interact.
  const currentSessionId = useMessagesStore((s) => s.currentSessionId);
  const agents = useAgentsStore((s) => s.agents);
  useEffect(() => {
    if (!currentSessionId) return;
    const { sessionMeta, sessionMessages, setSessionMeta } =
      useMessagesStore.getState();
    let meta = sessionMeta[currentSessionId];

    if (!meta) {
      const msgs = sessionMessages[currentSessionId] ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== "assistant") continue;
        if (m.agentId || m.modelId) {
          meta = { agentId: m.agentId, modelId: m.modelId };
          setSessionMeta(currentSessionId, meta);
          break;
        }
      }
    }

    if (!meta) return;
    if (meta.agentId) {
      if (agents.some((a) => a.id === meta.agentId)) {
        useAgentsStore.getState().selectAgent(meta.agentId);
      }
    }
    if (meta.modelId) {
      void useRuntimeStore.getState().selectModel(meta.modelId);
    }
  }, [currentSessionId, agents]);

  // Session-switch teardown — panes only. Sessions live inside a project,
  // so the project's dev server and any in-flight processes stay alive
  // (the user explicitly wants in-flight work to finish in the background
  // against its origin session). We just close the extra panes opened in
  // the previous session so the new one starts with a clean workspace.
  // The chat pane is always on (not in `extraPanes`), so it isn't affected.
  // This also fires on project switch — `clearPanes()` is idempotent, so
  // the double call is harmless and saves us from duplicating the logic.
  useEffect(() => {
    if (!currentSessionId) return;
    clearPanes();
  }, [currentSessionId, clearPanes]);

  return (
    <div className="flex h-screen flex-col gap-2 text-ink">
      <TopBar />
      <main className="min-h-0 flex-1 overflow-hidden">
        <Workspace />
      </main>
      <BottomBar />
      <FileFinder />
      <RuntimeToasts />
      <ModelBrowser />
      <PermissionRequestModal />
      <FolderPermissionModal />
      <AskUserSheet />
      <FirstRunOverlay />
    </div>
  );
}
