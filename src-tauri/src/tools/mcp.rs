//! MCP interop seam — the agnostic way AKA consumes **foreign** agents/tools.
//!
//! The STDIO transport is **live**: [`StdioTransport`] spawns the server as a
//! local subprocess (probe-style: `tokio::process::Command`, piped stdio,
//! killed on drop), speaks the minimal JSON-RPC 2.0 subset MCP discovery needs
//! (`initialize` → `notifications/initialized` → `tools/list`, newline-delimited),
//! and returns [`ForeignToolDecl`]s ready for
//! [`super::registry::Registry::add_foreign`] — discovery only, never dispatch.
//! Tool *invocation* (`tools/call`) is deliberately not implemented here.
//!
//! ## Local-first transport
//!
//! The default and only non-opt-in transport is **MCP over STDIO**: the foreign
//! agent is a local subprocess (consistent with the existing portable-pty/probe
//! model). A *remote* MCP server (Streamable HTTP) is opt-in only and is itself a
//! `network` action under the deny-by-default policy in [`super::policy`] — never
//! the default path; it remains an unimplemented stub. "Consume foreign agents
//! over MCP" means *local* agents speaking MCP first.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// How AKA reaches a foreign MCP server. STDIO (local subprocess) is the
/// local-first default; HTTP is opt-in and gated as a `network` action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum McpTransportKind {
    /// Local subprocess speaking MCP over stdin/stdout. The default.
    Stdio {
        /// The agent binary to spawn (resolved on PATH like every other agent).
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Remote MCP server (Streamable HTTP). Opt-in only; falls under the
    /// `network` deny-by-default policy — never auto-selected.
    Http { url: String },
}

/// A live MCP client. One capability only: enumerate the server's tools so
/// they can be classified through [`super::registry::Registry::add_foreign`].
#[allow(async_fn_in_trait)]
pub trait McpTransport {
    /// Connect, `initialize`, and `tools/list` — each foreign tool's name +
    /// description + raw annotations, ready for `Registry::add_foreign`.
    async fn list_tools(&self) -> Result<Vec<ForeignToolDecl>, String>;
}

// ---------------------------------------------------------------------------
// STDIO transport (live)
// ---------------------------------------------------------------------------

/// The MCP protocol revision AKA offers during `initialize`. Discovery-only, so
/// we never enforce on the server's counter-offer — any answer that carries a
/// `tools/list` result is good enough.
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Hard ceiling on one whole discovery (spawn → initialize → tools/list). Long
/// enough for an `npx`-wrapped server to cold-start, short enough that a hung
/// binary can't wedge the UI. The child is killed on drop either way.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);

/// How many non-response lines (server-initiated notifications/requests, log
/// noise on stdout) we tolerate while waiting for one response before giving up.
const MAX_SKIPPED_LINES: usize = 512;

/// Cap on `tools/list` pagination rounds — a well-behaved server needs a
/// handful; a broken cursor loop must not spin forever.
const MAX_TOOL_PAGES: usize = 16;

/// Live MCP-over-stdio client for [`McpTransportKind::Stdio`]. Spawns the
/// server, discovers its tools, and kills it — a short-lived subprocess per
/// discovery, never a held connection. Modeled on `commands::probe`'s
/// subprocess hygiene (piped stdio, `kill_on_drop`, hard timeout).
pub struct StdioTransport {
    pub command: String,
    pub args: Vec<String>,
}

impl McpTransport for StdioTransport {
    async fn list_tools(&self) -> Result<Vec<ForeignToolDecl>, String> {
        tokio::time::timeout(DISCOVERY_TIMEOUT, self.discover())
            .await
            .map_err(|_| {
                format!(
                    "MCP server `{}` didn't finish discovery within {}s",
                    self.command,
                    DISCOVERY_TIMEOUT.as_secs()
                )
            })?
    }
}

impl StdioTransport {
    async fn discover(&self) -> Result<Vec<ForeignToolDecl>, String> {
        // Resolve on PATH exactly like agents/probes do (login-shell fallback
        // included), so `npx`, `uvx`, etc. work from a GUI-launched app.
        let bin = self.command.clone();
        let program = tokio::task::spawn_blocking(move || crate::path_env::resolve_bin(&bin))
            .await
            .map_err(|e| format!("path resolution task failed: {e}"))?
            .ok_or_else(|| format!("MCP server binary not found on PATH: {}", self.command))?;

        let mut child = Command::new(&program)
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Servers routinely log to stderr; it's not part of the protocol.
            .stderr(Stdio::null())
            // A hung server dies with the future — it can never outlive us.
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", program.display()))?;

        let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;
        let stdout = child.stdout.take().ok_or("no stdout pipe")?;
        let mut lines = BufReader::new(stdout).lines();

        write_line(&mut stdin, &build_initialize(1)).await?;
        read_response(&mut lines, 1).await?;
        write_line(&mut stdin, &build_initialized_notification()).await?;

        // tools/list, following `nextCursor` pagination until exhausted.
        let mut tools: Vec<ForeignToolDecl> = Vec::new();
        let mut cursor: Option<String> = None;
        for page in 0..MAX_TOOL_PAGES {
            let id = 2 + page as u64;
            write_line(&mut stdin, &build_tools_list(id, cursor.as_deref())).await?;
            let result = read_response(&mut lines, id).await?;
            let (mut batch, next) = parse_tools_result(&result)?;
            tools.append(&mut batch);
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }

        // Discovery done — the subprocess has served its purpose.
        let _ = child.kill().await;
        Ok(tools)
    }
}

/// Write one newline-delimited JSON-RPC message (the MCP stdio framing).
async fn write_line(
    stdin: &mut tokio::process::ChildStdin,
    msg: &Value,
) -> Result<(), String> {
    let mut line = msg.to_string();
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write to MCP server failed: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush to MCP server failed: {e}"))
}

/// Read lines until the response for `id` arrives, skipping server-initiated
/// notifications/requests and non-JSON noise (bounded by [`MAX_SKIPPED_LINES`]).
async fn read_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: u64,
) -> Result<Value, String> {
    for _ in 0..MAX_SKIPPED_LINES {
        let line = lines
            .next_line()
            .await
            .map_err(|e| format!("read from MCP server failed: {e}"))?
            .ok_or("MCP server closed its stdout before responding")?;
        match parse_response_line(&line) {
            Some((got, outcome)) if got == id => return outcome,
            _ => continue, // someone else's message, a notification, or noise
        }
    }
    Err(format!(
        "gave up waiting for response {id}: more than {MAX_SKIPPED_LINES} unrelated lines"
    ))
}

// --- pure protocol helpers (unit-tested, no IO) ----------------------------

/// The `initialize` request. Capabilities are empty — we consume tools only.
pub fn build_initialize(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "aka", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

/// The `notifications/initialized` notification (no id — never answered).
pub fn build_initialized_notification() -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

/// The `tools/list` request, with the pagination cursor when continuing.
pub fn build_tools_list(id: u64, cursor: Option<&str>) -> Value {
    match cursor {
        Some(c) => json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/list",
            "params": { "cursor": c }
        }),
        None => json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list", "params": {} }),
    }
}

/// Classify one stdout line: `Some((id, Ok(result)))` for a success response,
/// `Some((id, Err(message)))` for a JSON-RPC error response, `None` for
/// notifications, server-initiated requests, and non-JSON noise.
pub fn parse_response_line(line: &str) -> Option<(u64, Result<Value, String>)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let id = v.get("id")?.as_u64()?;
    // A message with an id and a `method` is a server→client *request*, not a
    // response to us — skip it (we never answer; discovery doesn't need to).
    if v.get("method").is_some() {
        return None;
    }
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error")
            .to_string();
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(0);
        return Some((id, Err(format!("MCP server error {code}: {msg}"))));
    }
    Some((id, Ok(v.get("result").cloned().unwrap_or(Value::Null))))
}

/// Parse a `tools/list` result into declarations + the pagination cursor.
/// Tolerant by design: a missing `description` or `annotations` falls back to
/// the serde defaults (empty / all-None → most-restricted classification), and
/// unknown fields (`inputSchema`, `title`, …) are ignored.
pub fn parse_tools_result(
    result: &Value,
) -> Result<(Vec<ForeignToolDecl>, Option<String>), String> {
    let items = result
        .get("tools")
        .and_then(Value::as_array)
        .ok_or("malformed tools/list result: no `tools` array")?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let decl: ForeignToolDecl = serde_json::from_value(item.clone())
            .map_err(|e| format!("malformed tool declaration: {e}"))?;
        if decl.name.trim().is_empty() {
            return Err("malformed tool declaration: empty name".into());
        }
        out.push(decl);
    }
    let cursor = result
        .get("nextCursor")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    Ok((out, cursor))
}

/// One tool as a foreign MCP server advertises it — the input to classification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignToolDecl {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub annotations: super::capability::McpAnnotations,
}

/// Result of the probe handshake. Drives whether AKA can steer the agent's
/// phases/folders or must fall back to self-driving + MCP-baseline classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContractMode {
    /// The agent speaks `capability-contract: v1` → AKA drives its phases/folders.
    V1,
    /// The agent does not → fall back to MCP-baseline classification + default-deny
    /// and let the agent self-drive. AKA still enforces every call.
    McpBaseline,
}

/// The wire token AKA offers during the probe handshake.
pub const CONTRACT_V1: &str = "capability-contract: v1";

/// Negotiate the capability contract from a probe's advertised tokens.
///
/// Consumes the in-band handshake (`@@aka {"announce":"capability-contract",…}`)
/// token list. The companion [`contract_from_probe`] consumes the upfront
/// `--äkä-probe` JSON's `capability-contract` field; both apply the identical
/// v1-or-fallback rule so the two transports can never disagree.
pub fn negotiate(advertised: &[String]) -> ContractMode {
    if advertised.iter().any(|t| t == CONTRACT_V1) {
        ContractMode::V1
    } else {
        ContractMode::McpBaseline
    }
}

/// Negotiate the contract from the `--äkä-probe` JSON's `capability-contract`
/// field (e.g. `"v1"`). The same decision as [`negotiate`], keyed off the bare
/// version token the probe reports rather than the full announce string. A peer
/// that omits the field, or names any version other than v1, falls back to the
/// MCP-baseline (still fully enforced by the house layer).
pub fn contract_from_probe(capability_contract: Option<&str>) -> ContractMode {
    match capability_contract {
        Some(v) if v.trim().eq_ignore_ascii_case("v1") => ContractMode::V1,
        _ => ContractMode::McpBaseline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_agent_falls_back_to_baseline() {
        // A foreign agent that never heard of AKA → baseline (still enforced).
        assert_eq!(negotiate(&[]), ContractMode::McpBaseline);
        assert_eq!(
            negotiate(&["something-else".into()]),
            ContractMode::McpBaseline
        );
    }

    #[test]
    fn v1_agent_is_driven() {
        assert_eq!(negotiate(&[CONTRACT_V1.to_string()]), ContractMode::V1);
    }

    #[test]
    fn response_line_parsing_matches_ids_and_skips_noise() {
        // Success response with matching id.
        let (id, out) =
            parse_response_line(r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#).unwrap();
        assert_eq!(id, 7);
        assert_eq!(out.unwrap()["ok"], true);

        // Error response surfaces code + message.
        let (id, out) = parse_response_line(
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"nope"}}"#,
        )
        .unwrap();
        assert_eq!(id, 3);
        let msg = out.unwrap_err();
        assert!(msg.contains("-32601") && msg.contains("nope"));

        // Notifications (no id), server→client requests (id + method), and
        // non-JSON noise are all skipped.
        assert!(parse_response_line(r#"{"jsonrpc":"2.0","method":"log","params":{}}"#).is_none());
        assert!(parse_response_line(
            r#"{"jsonrpc":"2.0","id":9,"method":"roots/list","params":{}}"#
        )
        .is_none());
        assert!(parse_response_line("starting server on stdio...").is_none());
        assert!(parse_response_line("").is_none());
    }

    #[test]
    fn tools_result_parses_annotations_defaults_and_cursor() {
        // Full annotations + unknown fields (inputSchema/title) ignored.
        let result = serde_json::json!({
            "tools": [
                {
                    "name": "web_fetch",
                    "description": "fetch a url",
                    "inputSchema": {"type": "object"},
                    "title": "Web Fetch",
                    "annotations": {"readOnlyHint": true, "openWorldHint": true}
                },
                { "name": "bare_tool" }
            ],
            "nextCursor": "page-2"
        });
        let (tools, cursor) = parse_tools_result(&result).unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "web_fetch");
        assert_eq!(tools[0].annotations.read_only_hint, Some(true));
        assert_eq!(tools[0].annotations.open_world_hint, Some(true));
        // Missing description/annotations → serde defaults (classification will
        // put an unannotated tool in the most-restricted bucket).
        assert_eq!(tools[1].description, "");
        assert_eq!(tools[1].annotations, super::super::capability::McpAnnotations::default());
        assert_eq!(cursor.as_deref(), Some("page-2"));

        // No tools array → explicit error, empty cursor → None.
        assert!(parse_tools_result(&serde_json::json!({"nope": []})).is_err());
        let (t, c) =
            parse_tools_result(&serde_json::json!({"tools": [], "nextCursor": ""})).unwrap();
        assert!(t.is_empty() && c.is_none());
    }

    #[test]
    fn requests_are_well_formed_jsonrpc() {
        let init = build_initialize(1);
        assert_eq!(init["jsonrpc"], "2.0");
        assert_eq!(init["id"], 1);
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["clientInfo"]["name"], "aka");
        assert!(init["params"]["protocolVersion"].is_string());

        let n = build_initialized_notification();
        assert_eq!(n["method"], "notifications/initialized");
        assert!(n.get("id").is_none());

        let first = build_tools_list(2, None);
        assert_eq!(first["method"], "tools/list");
        assert!(first["params"].get("cursor").is_none());
        let next = build_tools_list(3, Some("page-2"));
        assert_eq!(next["params"]["cursor"], "page-2");
    }

    /// End-to-end against a fake stdio MCP server (a `sh` read/printf loop):
    /// proves spawn → initialize → initialized → paginated tools/list → parse,
    /// including stderr noise being ignored.
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_transport_discovers_tools_from_fake_server() {
        let script = r#"
echo "fake mcp server booting" >&2
read line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"0.0.0"}}}'
read line
read line
printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/progress","params":{}}'
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"read_thing","description":"reads","annotations":{"readOnlyHint":true}}],"nextCursor":"p2"}}'
read line
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"nuke_thing","description":"destroys","annotations":{"destructiveHint":true}}]}}'
"#;
        let t = StdioTransport {
            command: "sh".into(),
            args: vec!["-c".into(), script.into()],
        };
        let tools = t.list_tools().await.expect("discovery succeeds");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "read_thing");
        assert_eq!(tools[1].name, "nuke_thing");

        // The decls feed the UNMODIFIED classification path: agent-owned,
        // deny-by-default folders derived from the untrusted hints.
        let mut reg = super::super::registry::Registry::from_builtins();
        for d in &tools {
            reg.add_foreign(&d.name, &d.description, d.annotations.clone());
        }
        let read = reg.entries.iter().find(|e| e.name == "read_thing").unwrap();
        assert_eq!(read.owner, super::super::registry::ToolOwner::Agent);
        let nuke = reg.entries.iter().find(|e| e.name == "nuke_thing").unwrap();
        assert_eq!(nuke.owner, super::super::registry::ToolOwner::Agent);
        assert!(nuke.scope_policy.deny_by_default);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_transport_surfaces_server_error() {
        // Server rejects tools/list with a JSON-RPC error.
        let script = r#"
read line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"0"}}}'
read line
read line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"boom"}}'
"#;
        let t = StdioTransport {
            command: "sh".into(),
            args: vec!["-c".into(), script.into()],
        };
        let err = t.list_tools().await.unwrap_err();
        assert!(err.contains("boom"), "unexpected error: {err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_transport_reports_missing_binary() {
        let t = StdioTransport {
            command: "definitely-not-a-real-mcp-server-binary".into(),
            args: vec![],
        };
        let err = t.list_tools().await.unwrap_err();
        assert!(err.contains("not found"), "unexpected error: {err}");
    }

    #[test]
    fn probe_field_negotiates_the_same_way() {
        // The `--äkä-probe` JSON path agrees with the in-band announce path.
        assert_eq!(contract_from_probe(Some("v1")), ContractMode::V1);
        assert_eq!(contract_from_probe(Some("V1")), ContractMode::V1);
        assert_eq!(contract_from_probe(Some(" v1 ")), ContractMode::V1);
        // Anything else — a future version, a typo, or an absent field — is the
        // safe fallback. The house layer still enforces every call in baseline.
        assert_eq!(contract_from_probe(Some("v2")), ContractMode::McpBaseline);
        assert_eq!(contract_from_probe(Some("")), ContractMode::McpBaseline);
        assert_eq!(contract_from_probe(None), ContractMode::McpBaseline);
    }
}
