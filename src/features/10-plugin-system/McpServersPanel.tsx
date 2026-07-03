import { useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { HealthDot } from "../01-llm-provider/ConnectionPanel";
import { Tooltip } from "../../components/Tooltip";
import { formatCommandLine, parseCommandLine } from "./command-line";
import { useMcpStore, type McpServerStatus, type SavedMcpServer } from "./use-mcp-store";

/**
 * The Plugins popover — add/view/remove local (stdio) MCP server connections.
 * Connections are global (all projects); discovery is a short-lived subprocess
 * per connect, and the tools land in the registry as untrusted Agent-owned
 * entries. Borrowed the *persistence pattern* from the Runtime modal, but a
 * separate surface on purpose: MCP servers are a tool source, not a runtime.
 */
export function McpServersPanel() {
  const servers = useMcpStore((s) => s.servers);
  const statusByName = useMcpStore((s) => s.statusByName);
  const addServer = useMcpStore((s) => s.addServer);
  const rediscover = useMcpStore((s) => s.rediscover);
  const removeServer = useMcpStore((s) => s.removeServer);

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const submit = async () => {
    const parsed = parseCommandLine(commandLine);
    if (!parsed) {
      setAddError("Enter the command to launch the server (quotes allowed, no shell syntax).");
      return;
    }
    setAdding(true);
    setAddError(null);
    const res = await addServer(name, parsed.command, parsed.args);
    setAdding(false);
    if (!res.ok) {
      // Saved anyway — surface the discovery error but clear the form, the
      // entry now shows its own error state in the list.
      setAddError(res.error ?? null);
      if (!res.error?.includes("required")) {
        setShowAdd(false);
        setName("");
        setCommandLine("");
      }
      return;
    }
    setShowAdd(false);
    setName("");
    setCommandLine("");
  };

  return (
    <div className="flex flex-col gap-3 px-1 py-1 text-white">
      <div className="px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
          MCP servers · local (stdio)
        </span>
        <p className="pt-1 text-[10px] leading-relaxed text-white/40">
          Connect a local MCP server to discover its tools. Connections are
          global — set up once, available in every project.
        </p>
      </div>

      {servers.length > 0 ? (
        <div className="flex flex-col gap-1">
          {servers.map((s) => (
            <ServerRow
              key={s.name}
              server={s}
              status={statusByName[s.name] ?? { state: "idle", tools: [] }}
              onRediscover={() => void rediscover(s.name)}
              onRemove={() => void removeServer(s.name)}
            />
          ))}
        </div>
      ) : (
        <div className="px-2 text-[11px] text-white/40">
          No servers connected yet.
        </div>
      )}

      <div className="h-px bg-white/10" />

      {!showAdd ? (
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-2 rounded-xl px-2 py-2 text-xs text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Plus size={12} />
          Add MCP server
        </button>
      ) : (
        <div className="flex flex-col gap-2 px-1">
          <label className="text-[11px] uppercase tracking-wide text-white/50">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="filesystem"
            spellCheck={false}
            className="w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/40"
          />
          <label className="text-[11px] uppercase tracking-wide text-white/50">Command</label>
          <input
            value={commandLine}
            onChange={(e) => setCommandLine(e.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-everything"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="w-full rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-white outline-none placeholder:text-white/30 focus:border-white/40"
          />
          <p className="px-0.5 text-[10px] leading-relaxed text-white/40">
            Spawned directly (argv, no shell) and spoken to over stdio. The
            binary is resolved on your PATH like any agent.
          </p>
          {addError ? <div className="text-[11px] text-red-300">{addError}</div> : null}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setShowAdd(false);
                setAddError(null);
              }}
              className="rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              disabled={adding || !name.trim() || !commandLine.trim()}
              onClick={() => void submit()}
              className="rounded-lg bg-white/15 px-3 py-1 text-xs text-white hover:bg-white/25 disabled:opacity-50"
            >
              {adding ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      <p className="px-1 text-[10px] leading-relaxed text-white/35">
        Discovered tools are registered as untrusted, agent-owned entries in
        deny-by-default folders. AKA lists them; it never runs them itself.
      </p>
    </div>
  );
}

function statusLabel(status: McpServerStatus): string {
  switch (status.state) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return `${status.tools.length} tool${status.tools.length === 1 ? "" : "s"} discovered`;
    case "error":
      return status.error ?? "Connection failed";
    default:
      return "Not connected";
  }
}

function ServerRow({
  server,
  status,
  onRediscover,
  onRemove,
}: {
  server: SavedMcpServer;
  status: McpServerStatus;
  onRediscover: () => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const connecting = status.state === "connecting";
  const hasTools = status.state === "connected" && status.tools.length > 0;

  return (
    <div className="rounded-xl transition hover:bg-white/5">
      <div className="group flex w-full items-center gap-2 px-2 py-2">
        {status.state === "connecting" ? (
          <span
            style={{ width: 8, height: 8 }}
            className="inline-block shrink-0 animate-pulse rounded-full bg-amber-400"
          />
        ) : status.state === "idle" ? (
          <span
            style={{ width: 8, height: 8 }}
            className="inline-block shrink-0 rounded-full bg-white/25"
          />
        ) : (
          <HealthDot healthy={status.state === "connected"} />
        )}
        <button
          onClick={() => hasTools && setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
          title={formatCommandLine(server.command, server.args)}
        >
          <span className="flex items-center gap-1.5 text-xs text-white">
            {server.name}
            {hasTools ? (
              expanded ? <CaretDown size={10} className="text-white/40" /> : <CaretRight size={10} className="text-white/40" />
            ) : null}
          </span>
          <span
            className={[
              "max-w-full truncate text-[10px]",
              status.state === "error" ? "text-red-300/80" : "text-white/40",
            ].join(" ")}
          >
            {statusLabel(status)}
          </span>
        </button>
        <Tooltip label="Reconnect & re-discover tools" side="bottom">
          <button
            onClick={onRediscover}
            disabled={connecting}
            aria-label={`Reconnect ${server.name}`}
            className="shrink-0 rounded-lg p-1 text-white/50 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100 disabled:opacity-30"
          >
            <ArrowsClockwise size={13} className={connecting ? "animate-spin" : ""} />
          </button>
        </Tooltip>
        <Tooltip label="Remove this server" side="bottom">
          <button
            onClick={onRemove}
            aria-label={`Remove ${server.name}`}
            className="shrink-0 rounded-lg p-1 text-white/40 opacity-0 transition hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
          >
            <Trash size={13} />
          </button>
        </Tooltip>
      </div>

      {expanded && hasTools && (
        <ul className="mx-2 mb-2 flex flex-col gap-0.5 border-t border-white/8 pt-1.5">
          {status.tools.map((t) => (
            <li key={t.name} className="rounded px-2 py-1">
              <div className="font-mono text-[11px] text-white/80">{t.name}</div>
              {t.description ? (
                <div className="truncate text-[10px] text-white/40">{t.description}</div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
