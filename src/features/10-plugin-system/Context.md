# plugin-system

## Status
**Real, narrowly scoped: local (stdio) MCP server connections.** "Plugin"
here means exactly "connect AKA to a local MCP server and discover its
tools" — nothing broader.

What's built:
- **Rust transport** — `StdioTransport` in `src-tauri/src/tools/mcp.rs`:
  spawns the server as a short-lived subprocess (`tokio::process`, piped
  stdio, `kill_on_drop`, 20s ceiling, PATH-resolved like agents via
  `path_env::resolve_bin`), speaks the minimal newline-delimited JSON-RPC 2.0
  subset discovery needs (`initialize` → `notifications/initialized` →
  paginated `tools/list`), then kills the child. No connection is held open.
- **Commands** — `src-tauri/src/commands/mcp.rs`: `mcp_discover` runs one
  discovery pass and caches the declarations in a Tauri-managed
  `McpToolCache`; `mcp_forget` drops them. `tools::tool_registry` merges the
  cache into the registry view: built-ins plus every discovered tool appended
  through the **existing, unmodified** `Registry::add_foreign()` →
  `classify_foreign_tool()` path — each lands `ToolOwner::Agent` (untrusted)
  in the deny-by-default folder its (untrusted) annotations classify to.
- **Store** — [`use-mcp-store.ts`](./use-mcp-store.ts): saved connections
  (`{ name, command, args }`, upsert-by-name) persisted to
  `aka-mcp-servers.json` via tauri-plugin-store, **global across projects**
  (product decision: plugins are set up once, available everywhere).
  `bootstrap()` re-discovers every saved server on app start — connections
  survive restarts by *reconnecting*, never by trusting a stale tool list.
- **UI** — [`PluginsButton.tsx`](./PluginsButton.tsx) in the top bar (next to
  Runtime, same popover pattern, separate surface/store on purpose) opening
  [`McpServersPanel.tsx`](./McpServersPanel.tsx): add (name + shell-free
  command line, parsed by [`command-line.ts`](./command-line.ts)), status per
  server, expandable discovered-tool list, reconnect, remove.

## What is deliberately NOT built
- **No `tools/call` dispatch.** AKA discovers and classifies; it never
  invokes an MCP tool itself. Dispatch is where per-call enforcement wiring
  would begin — out of scope by design.
- **No HTTP/remote MCP.** `McpTransportKind::Http` stays an unimplemented
  stub; remote MCP is a `network` action under the deny-by-default policy
  and was explicitly excluded.
- **No marketplace/download flow, no new trust tier.** Everything from an
  MCP server is `ToolOwner::Agent`, full stop. `capability.rs`, `policy.rs`,
  and the enforcement in `registry.rs` were not modified.

## Decisions
- The command line in the add form is parsed into an argv and spawned
  directly — **never through a shell** (no expansions, pipes, or redirects).
- Discovery is a subprocess-per-connect, not a held session: simpler
  lifecycle, nothing to leak, and the cache (`McpToolCache`) is
  per-app-session — the persisted layer stores only how to reconnect.
- The probe handshake (`negotiate`/`ContractMode`, `--äkä-probe`) that shares
  `tools/mcp.rs` is a **separate system** (AKA's own agent-capability
  contract) and was left untouched.

## Open questions
- When `tools/call` dispatch lands (a future, security-reviewed pass), adopt
  the official `rmcp` SDK rather than growing the hand-rolled client — the
  minimal JSON-RPC subset here is right for discovery-only, not for a full
  protocol surface.
- The frontend learns discovery results only from `mcp_discover`'s return
  value; if a future pass adds background re-discovery, emit an event rather
  than polling.
