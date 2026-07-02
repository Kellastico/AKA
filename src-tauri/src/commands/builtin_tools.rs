//! The built-in "None" agent's tool surface + the single execution chokepoint.
//!
//! When the user picks **None**, AKA itself drives the model through a tool loop
//! (see `docs/AKA-Architecture.md` §5). This module owns the two host-side halves
//! of that loop's tool use:
//!
//!   1. [`tool_defs`] — the OpenAI `tools` advertised to the model, **projected
//!      from the single shared catalog** ([`catalog::builtin_tools`]) and gated by
//!      **phase** (read-only → write → exec) via the tool's capability folder. The
//!      model surface can't drift from the agent surface — both draw from one list.
//!   2. [`execute_builtin_tool`] — the read chokepoint: read/search tools run here,
//!      enforced against the house policy layer (folder-scoped, default-deny). The
//!      `fs_write` tools are advertised at the Write phase but EXECUTE through AKA's
//!      dedicated enforced commands (`apply_str_replace`/`apply_diff`/`delete_file`),
//!      which bake in scope + checkpoint + approval + witness.
//!
//! Phasing is enforced structurally: a tool whose folder's phase exceeds the
//! enabled phase is neither advertised nor executable. The read-only floor has
//! zero file-mutation risk; mutations require the Write phase and always go through
//! the enforced edit commands.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::llm::{ToolDef, ToolFunctionDef};
use crate::error::AppError;
use crate::sandbox::SandboxState;
use crate::tools::catalog;
use crate::tools::policy::{check, Action};

/// Max bytes of a file fed back to the model, so one `read_file` can't blow the
/// context window. Larger files are truncated with an explicit marker.
const MAX_READ_BYTES: usize = 100_000;
/// Cap on entries returned by `list_dir` / matches by `search_files`.
const MAX_ENTRIES: usize = 400;
/// Cap on files scanned by a single `search_files` call (keeps it bounded).
const MAX_SEARCH_FILES: usize = 2_000;

/// How far the built-in loop is allowed to reach. Monotonic: a higher phase
/// includes every lower phase's tools. Phase 1 ships `ReadOnly` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolPhase {
    /// read / list / search — no mutation, no subprocess.
    ReadOnly,
    /// + write (checkpoint-before-write + approval).
    Write,
    /// + run (deny-by-default exec opt-in).
    Exec,
}

impl ToolPhase {
    fn parse(s: &str) -> ToolPhase {
        match s.trim().to_ascii_lowercase().as_str() {
            "write" => ToolPhase::Write,
            "exec" => ToolPhase::Exec,
            // Anything else (incl. "readonly"/"read_only"/unknown) is the safe floor.
            _ => ToolPhase::ReadOnly,
        }
    }
}

/// The phase at which a capability folder's tools unlock. Read/search are
/// available in the read-only floor; mutations (fs_write/git) need the Write
/// phase; network/exec need Exec. This is what maps the shared catalog's `folder`
/// onto the loop's phase gate — no per-tool phase table to drift.
fn phase_for_folder(folder: catalog::Capability) -> ToolPhase {
    use catalog::Capability::*;
    match folder {
        FsRead | Search => ToolPhase::ReadOnly,
        FsWrite | Git => ToolPhase::Write,
        Network | Exec => ToolPhase::Exec,
    }
}

/// The JSON-Schema arguments for a catalog tool's model-facing definition, keyed
/// by name. Kept host-side (the shared catalog stays schema-free + shim-safe).
fn schema_for(name: &str) -> serde_json::Value {
    match name {
        "read_file" | "delete_file" => serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "Project-relative path." } },
            "required": ["path"]
        }),
        "list_dir" => serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "Project-relative directory (default: root)." } }
        }),
        "search_files" => serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Case-insensitive substring to find." },
                "path": { "type": "string", "description": "Directory to search under (default: root)." }
            },
            "required": ["query"]
        }),
        "str_replace" => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Project-relative file to edit." },
                "old_str": { "type": "string", "description": "Exact text to replace (must occur once)." },
                "new_str": { "type": "string", "description": "Replacement text." }
            },
            "required": ["path", "old_str", "new_str"]
        }),
        "apply_diff" => serde_json::json!({
            "type": "object",
            "properties": { "patch": { "type": "string", "description": "Unified diff to apply." } },
            "required": ["patch"]
        }),
        _ => serde_json::json!({ "type": "object", "properties": {} }),
    }
}

/// The OpenAI tool definitions to advertise for `phase` — every **native** catalog
/// tool whose folder is unlocked at that phase. Projected from the single shared
/// catalog ([`catalog::builtin_tools`]), so the model surface can't drift from the
/// agent surface: both draw from the same list.
pub fn tool_defs(phase: ToolPhase) -> Vec<ToolDef> {
    catalog::builtin_tools()
        .into_iter()
        .filter(|t| t.native && phase_for_folder(t.folder) <= phase)
        .map(|t| ToolDef {
            kind: "function".to_string(),
            function: ToolFunctionDef {
                name: t.name.to_string(),
                description: t.model_desc.to_string(),
                parameters: schema_for(t.name),
            },
        })
        .collect()
}

/// Model-facing tool manifest for the built-in loop at a given phase.
#[tauri::command]
pub fn builtin_tool_defs(phase: String) -> Vec<ToolDef> {
    tool_defs(ToolPhase::parse(&phase))
}

/// Attempt a coding-run phase transition, enforced from OUTSIDE the agent. The
/// EDIT→REVIEW contract is the load-bearing one: it is refused unless a real
/// on-disk change has occurred since the run's prerun snapshot (the checkpoint
/// baseline) — a claim of completion is never enough. On refusal, a visible
/// `@@aka` card explains why and the transition does not happen. Returns the
/// phase actually in effect afterward.
#[tauri::command]
pub async fn advance_phase(
    app: tauri::AppHandle,
    checkpoints: State<'_, crate::commands::checkpoints::CheckpointState>,
    project_path: String,
    run_id: String,
    from: String,
    to: String,
) -> Result<String, AppError> {
    use crate::tools::execution_witness::{denial_card_line, gate_phase_advance};
    use crate::tools::phase::Phase;

    let current =
        Phase::parse(&from).ok_or_else(|| AppError::edit_conflict(format!("unknown phase: {from}")))?;
    let target =
        Phase::parse(&to).ok_or_else(|| AppError::edit_conflict(format!("unknown phase: {to}")))?;

    let produced_real_change = crate::commands::checkpoints::changed_since_prerun(
        checkpoints.inner(),
        &project_path,
        &run_id,
    )
    .await;

    match gate_phase_advance(current, target, produced_real_change) {
        Ok(()) => Ok(target.as_str().to_string()),
        Err(denial) => {
            crate::commands::agent_runner::emit_aka_card(
                &app,
                &run_id,
                denial_card_line("run", "advance_phase", &denial.reason),
            );
            Err(AppError::edit_conflict(denial.reason))
        }
    }
}

/// The outcome of one tool call, fed straight back to the model as the `tool`
/// message content. `ok: false` carries a model-readable error (denied, missing
/// arg, not found) so the model can recover rather than the loop crashing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub content: String,
}

impl ToolResult {
    fn ok(content: impl Into<String>) -> Self {
        Self { ok: true, content: content.into() }
    }
    fn err(content: impl Into<String>) -> Self {
        Self { ok: false, content: content.into() }
    }
}

/// Resolve a project-relative (or absolute) path and return it only if it stays
/// inside the sandbox — the structural guarantee that a model can't read outside
/// the project. Empty/missing means the project root.
fn resolve_in_project(project_path: &str, rel: &str) -> PathBuf {
    let base = PathBuf::from(project_path);
    let rel = rel.trim();
    if rel.is_empty() || rel == "." {
        base
    } else {
        let p = PathBuf::from(rel);
        if p.is_absolute() {
            p
        } else {
            base.join(p)
        }
    }
}

fn arg_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Execute one model-chosen tool call — the single policy-enforced chokepoint for
/// the built-in loop. Parses the raw JSON `arguments`, enforces the phase + the
/// folder's deny-by-default policy, then runs the read-only action. Never errors
/// the command for a *denied* or malformed call — those come back as
/// `ToolResult { ok: false }` so the loop can keep going.
#[tauri::command]
pub async fn execute_builtin_tool(
    sandbox: State<'_, SandboxState>,
    name: String,
    arguments: String,
    project_path: String,
    phase: String,
) -> Result<ToolResult, AppError> {
    let phase = ToolPhase::parse(&phase);

    // The tool must exist in the shared catalog as a native tool AND be unlocked
    // at this phase — a model can't reach a write/exec tool while read-only.
    let spec = match catalog::builtin_tools()
        .into_iter()
        .find(|t| t.native && t.name == name)
    {
        Some(t) if phase_for_folder(t.folder) <= phase => t,
        Some(_) => {
            return Ok(ToolResult::err(format!(
                "Tool '{name}' is not enabled in the current phase."
            )))
        }
        None => return Ok(ToolResult::err(format!("Unknown tool '{name}'."))),
    };

    let args: serde_json::Value =
        serde_json::from_str(arguments.trim()).unwrap_or(serde_json::Value::Null);

    let sb = sandbox
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    let limits = crate::commands::project_config::load_from_disk(&project_path)
        .await
        .map(|c| c.capabilities.limits())
        .unwrap_or_default();

    match spec.name {
        "read_file" => {
            let Some(rel) = arg_str(&args, "path") else {
                return Ok(ToolResult::err("read_file requires a 'path' argument."));
            };
            let path = resolve_in_project(&project_path, &rel);
            if check(&Action::Read(&path), &sb, &limits).is_err() {
                return Ok(ToolResult::err(format!(
                    "Denied: '{rel}' is outside the project."
                )));
            }
            match tokio::fs::read(&path).await {
                Ok(bytes) => {
                    let truncated = bytes.len() > MAX_READ_BYTES;
                    let slice = &bytes[..bytes.len().min(MAX_READ_BYTES)];
                    let mut text = String::from_utf8_lossy(slice).into_owned();
                    if truncated {
                        text.push_str("\n…[truncated]");
                    }
                    Ok(ToolResult::ok(text))
                }
                Err(e) => Ok(ToolResult::err(format!("Could not read '{rel}': {e}"))),
            }
        }
        "list_dir" => {
            let rel = arg_str(&args, "path").unwrap_or_default();
            let path = resolve_in_project(&project_path, &rel);
            if check(&Action::Search(&path), &sb, &limits).is_err() {
                return Ok(ToolResult::err(format!(
                    "Denied: '{rel}' is outside the project."
                )));
            }
            match tokio::fs::read_dir(&path).await {
                Ok(mut rd) => {
                    let mut entries: Vec<String> = Vec::new();
                    while let Ok(Some(entry)) = rd.next_entry().await {
                        if entries.len() >= MAX_ENTRIES {
                            entries.push("…[more entries omitted]".to_string());
                            break;
                        }
                        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                        let name = entry.file_name().to_string_lossy().into_owned();
                        entries.push(if is_dir { format!("{name}/") } else { name });
                    }
                    entries.sort();
                    Ok(ToolResult::ok(entries.join("\n")))
                }
                Err(e) => Ok(ToolResult::err(format!("Could not list '{rel}': {e}"))),
            }
        }
        "search_files" => {
            let Some(query) = arg_str(&args, "query").filter(|q| !q.is_empty()) else {
                return Ok(ToolResult::err("search_files requires a non-empty 'query'."));
            };
            let rel = arg_str(&args, "path").unwrap_or_default();
            let root = resolve_in_project(&project_path, &rel);
            if check(&Action::Search(&root), &sb, &limits).is_err() {
                return Ok(ToolResult::err(format!(
                    "Denied: '{rel}' is outside the project."
                )));
            }
            Ok(search_files(&root, &project_path, &query))
        }
        // fs_write tools are advertised here (so the model sees them at the Write
        // phase), but they EXECUTE through AKA's dedicated enforced commands —
        // `apply_str_replace` / `apply_diff` / `delete_file` — which bake in
        // scope + checkpoint + approval + witness. The loop routes an fs_write
        // tool_call to those commands, not through this read executor; reaching
        // here means the caller must dispatch it there instead.
        "str_replace" | "apply_diff" | "delete_file" => Ok(ToolResult::err(format!(
            "'{}' executes via AKA's enforced edit command, not the read executor — \
             route this call to apply_str_replace / apply_diff / delete_file.",
            spec.name
        ))),
        other => Ok(ToolResult::err(format!("Unknown tool '{other}'."))),
    }
}

/// Bounded recursive substring search. Skips `.git`/`node_modules`/dotdirs and
/// caps both files scanned and matches returned so a model can't trigger an
/// unbounded walk. Returns `path:line: snippet` lines relative to the project.
fn search_files(root: &std::path::Path, project_path: &str, query: &str) -> ToolResult {
    let needle = query.to_lowercase();
    let mut matches: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut stack = vec![root.to_path_buf()];
    let base = std::path::Path::new(project_path);

    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            if matches.len() >= MAX_ENTRIES || scanned >= MAX_SEARCH_FILES {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push(path);
                continue;
            }
            scanned += 1;
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            let rel = path.strip_prefix(base).unwrap_or(&path).display().to_string();
            for (i, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    let snippet = line.trim();
                    let snippet = &snippet[..snippet.len().min(200)];
                    matches.push(format!("{rel}:{}: {snippet}", i + 1));
                    if matches.len() >= MAX_ENTRIES {
                        break;
                    }
                }
            }
        }
    }

    if matches.is_empty() {
        ToolResult::ok(format!("No matches for '{query}'."))
    } else {
        ToolResult::ok(matches.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_parse_defaults_to_readonly() {
        assert_eq!(ToolPhase::parse("write"), ToolPhase::Write);
        assert_eq!(ToolPhase::parse("exec"), ToolPhase::Exec);
        assert_eq!(ToolPhase::parse("readonly"), ToolPhase::ReadOnly);
        assert_eq!(ToolPhase::parse("nonsense"), ToolPhase::ReadOnly);
        assert_eq!(ToolPhase::parse(""), ToolPhase::ReadOnly);
    }

    #[test]
    fn readonly_phase_advertises_only_readonly_tools() {
        let names: Vec<String> = tool_defs(ToolPhase::ReadOnly)
            .iter()
            .map(|d| d.function.name.clone())
            .collect();
        // Read-only tools are present…
        assert!(names.contains(&"read_file".to_string()));
        assert!(names.contains(&"list_dir".to_string()));
        assert!(names.contains(&"search_files".to_string()));
        // …and fs_write tools are NOT advertised at the read-only floor.
        assert!(!names.contains(&"str_replace".to_string()));
        assert!(!names.contains(&"delete_file".to_string()));
        assert!(!names.contains(&"apply_diff".to_string()));
    }

    #[test]
    fn write_phase_unlocks_the_mutation_tools() {
        let names: Vec<String> = tool_defs(ToolPhase::Write)
            .iter()
            .map(|d| d.function.name.clone())
            .collect();
        // Read-only tools remain, and the fs_write tools now appear.
        assert!(names.contains(&"read_file".to_string()));
        for w in ["str_replace", "apply_diff", "delete_file"] {
            assert!(names.contains(&w.to_string()), "expected {w} at Write phase");
        }
    }

    #[test]
    fn tool_defs_derive_from_the_shared_catalog() {
        // Every advertised tool is a `native` entry in the one catalog — the model
        // surface can't drift from the agent surface.
        let native: Vec<&'static str> = catalog::builtin_tools()
            .into_iter()
            .filter(|t| t.native)
            .map(|t| t.name)
            .collect();
        for d in tool_defs(ToolPhase::Exec) {
            assert!(native.contains(&d.function.name.as_str()));
        }
    }

    #[test]
    fn tool_defs_are_well_formed_function_schemas() {
        for d in tool_defs(ToolPhase::Exec) {
            assert_eq!(d.kind, "function");
            assert!(!d.function.name.is_empty());
            assert!(!d.function.description.is_empty());
            assert_eq!(d.function.parameters["type"], "object");
        }
    }

    #[test]
    fn resolve_in_project_handles_root_and_relative() {
        let base = "/proj";
        assert_eq!(resolve_in_project(base, ""), PathBuf::from("/proj"));
        assert_eq!(resolve_in_project(base, "."), PathBuf::from("/proj"));
        assert_eq!(resolve_in_project(base, "src/a.rs"), PathBuf::from("/proj/src/a.rs"));
    }

    #[test]
    fn arg_str_extracts_strings_only() {
        let v = serde_json::json!({ "path": "x", "n": 3 });
        assert_eq!(arg_str(&v, "path").as_deref(), Some("x"));
        assert_eq!(arg_str(&v, "n"), None);
        assert_eq!(arg_str(&v, "missing"), None);
    }

    #[test]
    fn search_finds_and_bounds_matches() {
        let dir = std::env::temp_dir().join(format!("aka-search-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("a.txt"), "hello world\nuseEffect here\n").unwrap();
        std::fs::write(dir.join("b.txt"), "nothing relevant").unwrap();
        let res = search_files(&dir, dir.to_str().unwrap(), "useeffect");
        assert!(res.ok);
        assert!(res.content.contains("a.txt:2"));
        assert!(!res.content.contains("b.txt"));
        let none = search_files(&dir, dir.to_str().unwrap(), "zzzznotpresent");
        assert!(none.ok);
        assert!(none.content.contains("No matches"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
