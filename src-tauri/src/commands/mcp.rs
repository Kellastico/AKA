//! MCP server connection commands — **discovery only**.
//!
//! `mcp_discover` runs one short-lived [`StdioTransport`] pass (spawn →
//! `initialize` → `tools/list` → kill) and caches the declarations in
//! [`McpToolCache`] so `tools::tool_registry` can append them — through the
//! existing, unmodified `Registry::add_foreign` classification — as untrusted
//! `Agent`-owned entries. No connection is held open, nothing here dispatches
//! a tool call, and the persisted list of servers lives on the frontend
//! (`aka-mcp-servers.json`, the SavedRuntime pattern); this cache is
//! per-app-session state only.

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::tools::mcp::{ForeignToolDecl, McpTransport, StdioTransport};

/// Discovered tools per connected server, keyed by the user's display name for
/// the connection. BTreeMap so the registry merge (and therefore the UI) is
/// deterministically ordered.
#[derive(Default)]
pub struct McpToolCache(pub Mutex<BTreeMap<String, Vec<ForeignToolDecl>>>);

impl McpToolCache {
    /// Snapshot of every cached declaration, in stable (server-name) order.
    /// The registry merge consumes this — one flat list, classification happens
    /// tool-by-tool in `Registry::add_foreign`.
    pub fn all_decls(&self) -> Result<Vec<ForeignToolDecl>, String> {
        let cache = self.0.lock().map_err(|e| format!("mcp cache poisoned: {e}"))?;
        Ok(cache.values().flatten().cloned().collect())
    }
}

/// Connect to a local stdio MCP server, discover its tools, and cache them for
/// the registry. Returns the raw declarations so the UI can show what was
/// found. Re-running for the same `name` replaces the previous discovery.
#[tauri::command]
pub async fn mcp_discover(
    cache: tauri::State<'_, McpToolCache>,
    name: String,
    command: String,
    args: Vec<String>,
) -> Result<Vec<ForeignToolDecl>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("server name is required".into());
    }
    if command.trim().is_empty() {
        return Err("server command is required".into());
    }
    let transport = StdioTransport {
        command: command.trim().to_string(),
        args,
    };
    let tools = transport.list_tools().await?;
    cache
        .0
        .lock()
        .map_err(|e| format!("mcp cache poisoned: {e}"))?
        .insert(name, tools.clone());
    Ok(tools)
}

/// Drop a server's cached discovery (on remove/disconnect). The persisted
/// connection entry is the frontend's to delete; this only clears the tools
/// out of the live registry view.
#[tauri::command]
pub async fn mcp_forget(
    cache: tauri::State<'_, McpToolCache>,
    name: String,
) -> Result<(), String> {
    cache
        .0
        .lock()
        .map_err(|e| format!("mcp cache poisoned: {e}"))?
        .remove(name.trim());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_flattens_in_stable_order_and_forget_removes() {
        let cache = McpToolCache::default();
        let decl = |n: &str| ForeignToolDecl {
            name: n.into(),
            description: String::new(),
            annotations: Default::default(),
        };
        {
            let mut m = cache.0.lock().unwrap();
            m.insert("zeta".into(), vec![decl("z1")]);
            m.insert("alpha".into(), vec![decl("a1"), decl("a2")]);
        }
        let names: Vec<_> = cache.all_decls().unwrap().into_iter().map(|d| d.name).collect();
        // BTreeMap: alpha's tools first, then zeta's.
        assert_eq!(names, vec!["a1", "a2", "z1"]);

        cache.0.lock().unwrap().remove("alpha");
        let names: Vec<_> = cache.all_decls().unwrap().into_iter().map(|d| d.name).collect();
        assert_eq!(names, vec!["z1"]);
    }
}
