import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";
import {
  mcpDiscover,
  mcpForget,
  type ForeignToolDecl,
} from "../../lib/tauri/commands";

/**
 * Saved MCP server connections — the plugin system's persistence layer.
 * Mirrors the SavedRuntime pattern (`use-runtime-store.ts`): a global list in
 * its own tauri-plugin-store file, reused across all projects (plugins are
 * global by product decision), upserted by unique key (`name`), persisted on
 * every mutation, no localStorage.
 *
 * Discovery is per-app-session: `bootstrap()` re-runs `mcpDiscover` for every
 * saved server on launch, so connections "survive restarts" by reconnecting,
 * not by trusting stale tool lists.
 */

export type SavedMcpServer = {
  /** Display name, unique key for the connection. */
  name: string;
  /** Binary to spawn (resolved on PATH by the backend, like agents). */
  command: string;
  args: string[];
};

export type McpServerStatus = {
  state: "idle" | "connecting" | "connected" | "error";
  /** Set when state === "error". */
  error?: string;
  /** Tools from the last successful discovery (state === "connected"). */
  tools: ForeignToolDecl[];
};

const MCP_STORE_FILE = "aka-mcp-servers.json";
const SAVED_SERVERS_KEY = "savedMcpServers";

async function persistServers(list: SavedMcpServer[]): Promise<void> {
  try {
    const store = await load(MCP_STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(SAVED_SERVERS_KEY, list);
    await store.save();
  } catch {
    // Outside Tauri (browser dev) — in-memory only.
  }
}

type McpState = {
  servers: SavedMcpServer[];
  statusByName: Record<string, McpServerStatus>;
  initialized: boolean;
  /** Load persisted servers and re-discover each — call once on app start. */
  bootstrap: () => Promise<void>;
  /**
   * Upsert a server (keyed by name), persist it, then discover its tools.
   * Resolves ok:false with the discovery error when the server can't be
   * reached — the entry is still saved so the user can fix and retry.
   */
  addServer: (
    name: string,
    command: string,
    args: string[],
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Re-run discovery for one saved server. */
  rediscover: (name: string) => Promise<void>;
  /** Remove a server: forget its cached tools and persist the deletion. */
  removeServer: (name: string) => Promise<void>;
};

export const useMcpStore = create<McpState>((set, get) => {
  const setStatus = (name: string, status: McpServerStatus) =>
    set((s) => ({ statusByName: { ...s.statusByName, [name]: status } }));

  const discover = async (server: SavedMcpServer): Promise<{ ok: boolean; error?: string }> => {
    setStatus(server.name, { state: "connecting", tools: [] });
    try {
      const tools = await mcpDiscover(server.name, server.command, server.args);
      setStatus(server.name, { state: "connected", tools });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(server.name, { state: "error", error: msg, tools: [] });
      return { ok: false, error: msg };
    }
  };

  return {
    servers: [],
    statusByName: {},
    initialized: false,

    bootstrap: async () => {
      if (get().initialized) return;
      set({ initialized: true });
      let saved: SavedMcpServer[] = [];
      try {
        const store = await load(MCP_STORE_FILE, { defaults: {}, autoSave: false });
        saved = (await store.get<SavedMcpServer[]>(SAVED_SERVERS_KEY)) ?? [];
      } catch {
        // Outside Tauri — nothing persisted.
      }
      set({
        servers: saved,
        statusByName: Object.fromEntries(
          saved.map((s) => [s.name, { state: "idle", tools: [] } as McpServerStatus]),
        ),
      });
      // Reconnect sequentially — each discovery is a short-lived subprocess;
      // avoid a spawn burst when many servers are saved.
      for (const server of saved) {
        await discover(server);
      }
    },

    addServer: async (name, command, args) => {
      const trimmed = name.trim();
      if (!trimmed) return { ok: false, error: "Name is required" };
      if (!command.trim()) return { ok: false, error: "Command is required" };
      const server: SavedMcpServer = { name: trimmed, command: command.trim(), args };
      const next = [...get().servers.filter((s) => s.name !== trimmed), server];
      set({ servers: next });
      void persistServers(next);
      return discover(server);
    },

    rediscover: async (name) => {
      const server = get().servers.find((s) => s.name === name);
      if (server) await discover(server);
    },

    removeServer: async (name) => {
      const next = get().servers.filter((s) => s.name !== name);
      set((s) => {
        const statusByName = { ...s.statusByName };
        delete statusByName[name];
        return { servers: next, statusByName };
      });
      void persistServers(next);
      try {
        await mcpForget(name);
      } catch {
        // Cache clear is best-effort; the persisted removal already happened.
      }
    },
  };
});
