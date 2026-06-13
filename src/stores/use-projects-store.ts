import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import {
  DEFAULT_PROJECT_CONFIG,
  clearCheckpoints,
  saveConfig,
  type ProjectConfig,
} from "../lib/tauri/commands";
import { useAgentsStore } from "./use-agents-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";

export type Session = {
  id: string;
  title: string;
  updatedAt: string;
};

export type DisplayMode =
  | "sheet"
  | "morph"
  | "tower"
  | "spotlight"
  | "takeover";

/**
 * Permission the user has granted the agent for this project's folder.
 * `read`   — agent can read files but never write
 * `review` — agent reads + proposes edits; every write goes through approval
 * `write`  — agent reads, writes, and reviews changes autonomously
 * `undefined` — permission not yet granted; UI must prompt before any agent run
 */
export type AccessLevel = "read" | "review" | "write";

export type Project = {
  id: string;
  name: string;
  path: string;
  sessions: Session[];
  displayMode: DisplayMode;
  accessLevel?: AccessLevel;
};

type ProjectsState = {
  projects: Project[];
  activeProjectId: string | null;
  /** Currently-selected session within the active project (newest by default). */
  activeSessionId: string | null;
  takeoverProjectId: string | null;
  init: () => Promise<void>;
  addProject: (folderPath: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  setActiveProject: (id: string | null) => void;
  setActiveSession: (id: string | null) => void;
  /**
   * Atomically activate a project and a specific session in a single store
   * update. Use this instead of calling setActiveProject + setActiveSession
   * separately — the two-call sequence emits an intermediate null activeSessionId
   * that causes the session-message sync hook to fire twice (null → id), which
   * briefly clears the chat before reloading it.
   */
  activateSession: (projectId: string, sessionId: string) => void;
  setTakeover: (id: string | null) => void;
  startNewSession: (projectId: string) => Promise<void>;
  /** Rename a session within a project. */
  updateSessionTitle: (
    projectId: string,
    sessionId: string,
    title: string,
  ) => Promise<void>;
  /** Permanently delete a session. */
  deleteSession: (projectId: string, sessionId: string) => Promise<void>;
  setAccessLevel: (projectId: string, level: AccessLevel) => Promise<void>;
};

const STORE_FILE = "aka-projects.json";
const STORE_KEY = "projects";
const ACTIVE_PROJECT_KEY = "activeProjectId";
const ACTIVE_SESSION_KEY = "activeSessionId";

async function persist(projects: Project[]) {
  try {
    const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(STORE_KEY, projects);
    await store.save();
  } catch {
    // Outside Tauri (browser dev) — in-memory only
  }
}

/**
 * Persist the active project + session pointers separately from the project
 * list. These pointers are what tells the app "which project / session was
 * I in?" — and without persisting them, a WebView reload (Vite HMR, manual,
 * any cause) lands the user on the welcome hero with no selection, even
 * though their projects + chat history are still on disk.
 */
async function persistActiveIds(
  activeProjectId: string | null,
  activeSessionId: string | null,
) {
  try {
    const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(ACTIVE_PROJECT_KEY, activeProjectId);
    await store.set(ACTIVE_SESSION_KEY, activeSessionId);
    await store.save();
  } catch {
    // Outside Tauri (browser dev) — in-memory only
  }
}

function folderName(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() ?? path;
}

function newSession(): Session {
  return {
    id: crypto.randomUUID(),
    title: "New session",
    updatedAt: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  };
}

/**
 * Build the `.äkä/config.json` we want to scaffold for a freshly-imported
 * project. Seeded from the user's current global selections (last-used agent
 * + runtime), so importing a project after the first-run wizard or after
 * working in another project results in a launchable config with zero
 * follow-up clicks. Falls back to empty defaults when nothing is selected
 * yet — the existing first-run wizard then fills it in.
 *
 * Note: this does *not* introduce a global config. The scaffold writes once
 * at import time; from then on the per-project file is the only source of
 * truth and can diverge freely.
 */
function buildSeededConfig(projectPath: string): ProjectConfig {
  const agentsState = useAgentsStore.getState();
  const runtimeState = useRuntimeStore.getState();

  const selectedAgent =
    agentsState.selectedAgentId
      ? agentsState.agents.find((a) => a.id === agentsState.selectedAgentId)
      : undefined;

  const baseUrl =
    runtimeState.active?.baseUrl ?? DEFAULT_PROJECT_CONFIG.runtime.base_url;
  const apiKey =
    runtimeState.active?.apiKey ?? DEFAULT_PROJECT_CONFIG.runtime.api_key;
  const model = runtimeState.selectedModelId ?? DEFAULT_PROJECT_CONFIG.runtime.model;

  return {
    ...DEFAULT_PROJECT_CONFIG,
    runtime: { base_url: baseUrl, model, api_key: apiKey },
    agent: selectedAgent
      ? {
          ...DEFAULT_PROJECT_CONFIG.agent,
          name: selectedAgent.name,
          bin: selectedAgent.bin,
          args: [...selectedAgent.args],
        }
      : { ...DEFAULT_PROJECT_CONFIG.agent },
    sandbox: { project_path: projectPath },
  };
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  activeSessionId: null,
  takeoverProjectId: null,

  init: async () => {
    try {
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      const saved = await store.get<Project[]>(STORE_KEY);
      const savedActiveProjectId = await store.get<string | null>(
        ACTIVE_PROJECT_KEY,
      );
      const savedActiveSessionId = await store.get<string | null>(
        ACTIVE_SESSION_KEY,
      );

      const update: Partial<ProjectsState> = {};
      if (Array.isArray(saved) && saved.length > 0) {
        update.projects = saved;
      }
      // Only restore the pointers if they still match a known project — a
      // stale id from a deleted project would land the app on a phantom
      // selection. activeSessionId is similarly validated against the
      // restored project's session list.
      const projectsForLookup = update.projects ?? get().projects;
      if (
        typeof savedActiveProjectId === "string" &&
        projectsForLookup.some((p) => p.id === savedActiveProjectId)
      ) {
        update.activeProjectId = savedActiveProjectId;
        if (typeof savedActiveSessionId === "string") {
          const proj = projectsForLookup.find(
            (p) => p.id === savedActiveProjectId,
          );
          if (proj?.sessions.some((s) => s.id === savedActiveSessionId)) {
            update.activeSessionId = savedActiveSessionId;
          }
        }
      }
      if (Object.keys(update).length > 0) {
        set(update);
      }
    } catch {
      // Outside Tauri — keep empty
    }
  },

  addProject: async (folderPath: string) => {
    // Every import starts with its own fresh session, activated atomically
    // with the project. Without this the previous project's activeSessionId
    // survived the import — the session-message sync hook saw no change and
    // kept the old project's chat on screen under the new project.
    const session = newSession();
    const project: Project = {
      id: crypto.randomUUID(),
      name: folderName(folderPath),
      path: folderPath,
      sessions: [session],
      displayMode: "morph",
    };
    const projects = [...get().projects, project];
    set({
      projects,
      activeProjectId: project.id,
      activeSessionId: session.id,
    });
    await persist(projects);
    await persistActiveIds(project.id, session.id);

    // Scaffold .äkä/config.json immediately, seeded from the user's last-used
    // agent + runtime. Without this, the very first launch in a freshly-
    // imported project fails with `agent.bin is not configured` because the
    // file doesn't exist yet and load_from_disk returns empty defaults. Best-
    // effort: a failed scaffold (no Tauri bridge, permission denied) must
    // not block adding the project to the list.
    try {
      const seeded = buildSeededConfig(folderPath);
      await saveConfig(folderPath, seeded);
    } catch {
      // Browser dev preview or filesystem error — fall through. The runner
      // will still show its "not configured" error if the user tries to
      // launch, and the configure-project modal can recover from there.
    }
  },

  removeProject: async (id: string) => {
    const projects = get().projects.filter((p) => p.id !== id);
    const activeProjectId =
      get().activeProjectId === id ? null : get().activeProjectId;
    const activeSessionId =
      get().activeProjectId === id ? null : get().activeSessionId;
    set({ projects, activeProjectId, activeSessionId });
    await persist(projects);
    await persistActiveIds(activeProjectId, activeSessionId);
  },

  setActiveProject: (id) => {
    // Guard same-id calls — selecting the already-active project would
    // otherwise reset activeSessionId to null and cause the session-message
    // sync hook to fire twice (null → newId), churning the chat history.
    if (get().activeProjectId === id) return;
    set({ activeProjectId: id, activeSessionId: null });
    void persistActiveIds(id, null);
  },
  setActiveSession: (id) => {
    if (get().activeSessionId === id) return;
    set({ activeSessionId: id });
    void persistActiveIds(get().activeProjectId, id);
  },
  activateSession: (projectId, sessionId) => {
    const s = get();
    if (s.activeProjectId === projectId && s.activeSessionId === sessionId) return;
    set({ activeProjectId: projectId, activeSessionId: sessionId });
    void persistActiveIds(projectId, sessionId);
  },
  setTakeover: (id) => set({ takeoverProjectId: id }),

  setAccessLevel: async (projectId, level) => {
    const projects = get().projects.map((p) =>
      p.id === projectId ? { ...p, accessLevel: level } : p,
    );
    set({ projects });
    await persist(projects);
  },

  startNewSession: async (projectId) => {
    const session = newSession();
    const projects = get().projects.map((p) =>
      p.id === projectId ? { ...p, sessions: [session, ...p.sessions] } : p,
    );
    set({
      projects,
      activeProjectId: projectId,
      activeSessionId: session.id,
    });
    await persist(projects);
    await persistActiveIds(projectId, session.id);
  },

  updateSessionTitle: async (projectId, sessionId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const projects = get().projects.map((p) =>
      p.id === projectId
        ? {
            ...p,
            sessions: p.sessions.map((s) =>
              s.id === sessionId ? { ...s, title: trimmed } : s,
            ),
          }
        : p,
    );
    set({ projects });
    await persist(projects);
  },

  deleteSession: async (projectId, sessionId) => {
    // Drop this session's checkpoint refs (sessionId == run id) so the private
    // `refs/aka/checkpoints/<session>/*` don't accumulate in the user's repo.
    // Best-effort — never block the delete.
    const projectPath = get().projects.find((p) => p.id === projectId)?.path;
    if (projectPath) void clearCheckpoints(projectPath, sessionId);

    const projects = get().projects.map((p) =>
      p.id === projectId
        ? { ...p, sessions: p.sessions.filter((s) => s.id !== sessionId) }
        : p,
    );
    const stillActive =
      get().activeSessionId === sessionId ? null : get().activeSessionId;
    set({ projects, activeSessionId: stillActive });
    await persist(projects);
    await persistActiveIds(get().activeProjectId, stillActive);
  },
}));

export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  sheet: "Bottom sheet",
  morph: "Pill morph",
  tower: "Inline tower",
  spotlight: "Spotlight",
  takeover: "Project mode",
};
