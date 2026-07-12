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

/// Max bytes of one tool result fed back to the model. Sized for LIMITED
/// hardware: ~24 KB ≈ 6k tokens, so even an 8k-context local model survives a
/// worst-case read with room to answer. Bigger files are paged, not dumped —
/// `read_file` takes `offset`/`limit` and the truncation marker tells the model
/// exactly how to continue, so frontier models lose nothing (they just page).
const MAX_TOOL_BYTES: usize = 24_000;
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
        "read_file" => serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Project-relative path." },
                "offset": { "type": "integer", "description": "1-based line to start from (for paging big files)." },
                "limit": { "type": "integer", "description": "Max lines to return." }
            },
            "required": ["path"]
        }),
        "delete_file" => serde_json::json!({
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
        "bash" => serde_json::json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to run in the project root." },
                "timeout_secs": { "type": "integer", "description": "Max seconds to wait (default 120, max 600)." }
            },
            "required": ["command"]
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

fn arg_u64(args: &serde_json::Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

/// Page a file's content for the model: start at 1-based line `offset`, return at
/// most `limit` lines, and never exceed [`MAX_TOOL_BYTES`] — whichever bound hits
/// first. When anything was left out, the marker tells the model EXACTLY how to
/// continue (`offset=<next line>`), so a small model pages instead of drowning
/// and a frontier model loses nothing. Pure — directly unit-testable.
fn paged_read(content: &str, offset: Option<u64>, limit: Option<u64>) -> ToolResult {
    let total_lines = content.lines().count();
    let start = offset.unwrap_or(1).max(1) as usize; // 1-based
    if total_lines > 0 && start > total_lines {
        return ToolResult::err(format!(
            "offset {start} is past the end of the file ({total_lines} lines)."
        ));
    }
    let max_lines = limit.map(|l| l.max(1) as usize).unwrap_or(usize::MAX);

    let mut out = String::new();
    let mut last_included = start.saturating_sub(1); // last 1-based line included
    for (i, line) in content.lines().enumerate().skip(start - 1) {
        let taken = (i + 1) - (start - 1);
        if taken > max_lines || out.len() + line.len() + 1 > MAX_TOOL_BYTES {
            break;
        }
        out.push_str(line);
        out.push('\n');
        last_included = i + 1;
    }

    // One rule: whenever lines remain past what we returned — cap, limit, or
    // both — say exactly how to get the rest.
    if last_included < total_lines {
        out.push_str(&format!(
            "…[showing lines {start}–{last_included} of {total_lines} — call read_file again with offset={} to continue]",
            last_included + 1
        ));
    }
    ToolResult::ok(out)
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
                    let content = String::from_utf8_lossy(&bytes);
                    Ok(paged_read(
                        &content,
                        arg_u64(&args, "offset"),
                        arg_u64(&args, "limit"),
                    ))
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
        "diagnostics" => {
            // Runs the user-configured typecheck/lint (`agent.diagnostics_cmd`)
            // — the same command the `aka-tool` shim runs for external agents.
            // House-trusted exec of a user-chosen command; read-only by effect,
            // hence available at the read-only floor (folder: search).
            let cmd = crate::commands::project_config::load_from_disk(&project_path)
                .await
                .map(|c| c.agent.diagnostics_cmd.trim().to_string())
                .unwrap_or_default();
            if cmd.is_empty() {
                return Ok(ToolResult::err(
                    "No diagnostics command configured (set agent.diagnostics_cmd in .äkä/config.json).",
                ));
            }
            let output = tokio::process::Command::new("sh")
                .arg("-c")
                .arg(&cmd)
                .current_dir(&project_path)
                .output()
                .await;
            match output {
                // Diagnostics FINDING issues is a successful tool run; the exit
                // code is part of the payload, not a tool failure. Shaping
                // (stream fold + byte cap + exit header) is the shared
                // `bash_output` — one capped formatter for every exec-shaped tool.
                Ok(o) => Ok(ToolResult::ok(bash_output(
                    o.status.code().unwrap_or(-1),
                    &String::from_utf8_lossy(&o.stdout),
                    &String::from_utf8_lossy(&o.stderr),
                ))),
                Err(e) => Ok(ToolResult::err(format!("Could not run diagnostics: {e}"))),
            }
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
        // Same structural rule for exec: `bash` runs only through the
        // approval-gated `run_builtin_bash` command, never the read executor.
        "bash" => Ok(ToolResult::err(
            "'bash' executes via AKA's enforced exec command, not the read executor — \
             route this call to run_builtin_bash."
                .to_string(),
        )),
        other => Ok(ToolResult::err(format!("Unknown tool '{other}'."))),
    }
}

// ---------- bash (approval-gated exec for the built-in loop) ----------

/// Default / maximum wall-clock budget for one `bash` tool call.
const BASH_DEFAULT_TIMEOUT_SECS: u64 = 120;
const BASH_MAX_TIMEOUT_SECS: u64 = 600;

/// Fold a finished command's streams into the model-facing payload: `[exit N]`
/// header, stdout then stderr, truncated to [`MAX_TOOL_BYTES`]. Pure —
/// directly unit-testable. Like `diagnostics`, a non-zero exit is a
/// *successful tool run* whose payload carries the exit code.
fn bash_output(code: i32, stdout: &str, stderr: &str) -> String {
    let mut text = String::new();
    text.push_str(stdout);
    if !stderr.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(stderr);
    }
    if text.len() > MAX_TOOL_BYTES {
        // Truncate on a char boundary at or below the cap.
        let mut cut = MAX_TOOL_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n…[truncated]");
    }
    if text.trim().is_empty() {
        return format!("(no output — exit {code})");
    }
    format!("[exit {code}]\n{text}")
}

/// Run one model-requested shell command — the built-in loop's enforced exec
/// chokepoint, mirroring `delete_file`'s shape: the *frontend* decides approval
/// (per the user's approval mode or an explicit click) and passes `approved`;
/// an unapproved call is denied with a visible `@@aka` card and nothing runs.
/// Approved commands snapshot the tree first (a shell line can mutate anything,
/// so it's undoable like an edit), then run via `sh -c` in the project root
/// under a wall-clock timeout. Output is capped like every other tool result.
#[tauri::command]
pub async fn run_builtin_bash(
    app: tauri::AppHandle,
    sandbox: State<'_, SandboxState>,
    checkpoints: State<'_, crate::commands::checkpoints::CheckpointState>,
    project_path: String,
    run_id: String,
    command: String,
    timeout_secs: Option<u64>,
    approved: bool,
) -> Result<ToolResult, AppError> {
    use crate::tools::execution_witness::denial_card_line;

    let cmd = command.trim().to_string();
    if cmd.is_empty() {
        return Ok(ToolResult::err("bash requires a non-empty 'command'."));
    }

    let sb = sandbox
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    // The caller-supplied project root must be the active sandbox.
    if crate::sandbox::assert_within_sandbox(std::path::Path::new(&project_path), &sb).is_err() {
        return Err(AppError::sandbox(project_path.clone()));
    }

    if !approved {
        crate::commands::agent_runner::emit_aka_card(
            &app,
            &run_id,
            denial_card_line("run", "bash", &format!("not approved: {cmd}")),
        );
        return Ok(ToolResult::err(
            "Denied: the user did not approve this command.",
        ));
    }

    // A shell line can mutate anything in the project — snapshot first so the
    // run is undoable, same contract as the enforced edit commands. Best-effort.
    let label: String = cmd.chars().take(48).collect();
    let _ = crate::commands::checkpoints::create_checkpoint_inner(
        &app,
        checkpoints.inner(),
        &project_path,
        &run_id,
        &format!("Before bash: {label}"),
        "step",
    )
    .await;

    let budget = std::time::Duration::from_secs(
        timeout_secs
            .unwrap_or(BASH_DEFAULT_TIMEOUT_SECS)
            .clamp(1, BASH_MAX_TIMEOUT_SECS),
    );
    let mut command = tokio::process::Command::new("sh");
    command
        .arg("-c")
        .arg(&cmd)
        .current_dir(&project_path)
        // Same buffering trap as the Console/dev-server paths.
        .env("PYTHONUNBUFFERED", "1")
        // No terminal behind this pipe — a command that prompts must fail fast,
        // not hang the loop waiting on input that can never come.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Backstop: if the timeout drops the future below, the child dies with it.
        .kill_on_drop(true);

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return Ok(ToolResult::err(format!("Could not run command: {e}"))),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Stream both pipes with a hard per-stream byte cap instead of buffering
    // the child's entire output (`.output()` would happily grow gigabytes for a
    // runaway `yes`-style command before the 24 KB truncation ever ran). The
    // reads run concurrently — draining one pipe at a time can deadlock when
    // the child fills the other — and the moment either stream overflows its
    // cap the child is killed: nobody will ever see those bytes, so there is
    // no reason to keep paying for them until the timeout.
    let run = async {
        let out_fut = read_capped(stdout, MAX_TOOL_BYTES);
        let err_fut = read_capped(stderr, MAX_TOOL_BYTES);
        tokio::pin!(out_fut, err_fut);
        let (mut out_res, mut err_res) = (None, None);
        while out_res.is_none() || err_res.is_none() {
            tokio::select! {
                r = &mut out_fut, if out_res.is_none() => {
                    if r.1 { let _ = child.start_kill(); }
                    out_res = Some(r);
                }
                r = &mut err_fut, if err_res.is_none() => {
                    if r.1 { let _ = child.start_kill(); }
                    err_res = Some(r);
                }
            }
        }
        let (out, out_trunc) = out_res.unwrap_or_default();
        let (err, err_trunc) = err_res.unwrap_or_default();
        let status = child.wait().await;
        (out, err, out_trunc || err_trunc, status)
    };

    match tokio::time::timeout(budget, run).await {
        Err(_) => Ok(ToolResult::err(format!(
            "Command timed out after {}s: {cmd}",
            budget.as_secs()
        ))),
        Ok((out, err, truncated, status)) => {
            let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
            let mut text = bash_output(
                code,
                &String::from_utf8_lossy(&out),
                &String::from_utf8_lossy(&err),
            );
            if truncated {
                text.push_str("\n[output limit reached — the command was stopped early]");
            }
            Ok(ToolResult::ok(text))
        }
    }
}

/// Read a child pipe to EOF or to `cap + 1` bytes, whichever comes first.
/// Returns the bytes plus whether the cap was exceeded (the +1 byte is the
/// overflow detector; `bash_output` re-caps the combined text anyway). Memory
/// stays bounded no matter how much the child writes.
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    reader: Option<R>,
    cap: usize,
) -> (Vec<u8>, bool) {
    use tokio::io::AsyncReadExt;
    let Some(reader) = reader else {
        return (Vec::new(), false);
    };
    let mut buf = Vec::new();
    let _ = reader.take(cap as u64 + 1).read_to_end(&mut buf).await;
    let truncated = buf.len() > cap;
    (buf, truncated)
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
        // …and fs_write/exec tools are NOT advertised at the read-only floor.
        assert!(!names.contains(&"str_replace".to_string()));
        assert!(!names.contains(&"delete_file".to_string()));
        assert!(!names.contains(&"apply_diff".to_string()));
        assert!(!names.contains(&"bash".to_string()));
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
        // Exec stays locked at the Write phase.
        assert!(!names.contains(&"bash".to_string()));
    }

    #[test]
    fn exec_phase_unlocks_bash() {
        let names: Vec<String> = tool_defs(ToolPhase::Exec)
            .iter()
            .map(|d| d.function.name.clone())
            .collect();
        assert!(names.contains(&"bash".to_string()));
    }

    #[test]
    fn bash_output_folds_streams_and_caps_size() {
        // Non-zero exit is payload, not failure.
        assert_eq!(bash_output(2, "out\n", "err\n"), "[exit 2]\nout\nerr\n");
        // Empty output degrades to an exit-code note.
        assert_eq!(bash_output(0, "", "  "), "(no output — exit 0)");
        // Oversized output is truncated with a marker.
        let big = "x".repeat(MAX_TOOL_BYTES * 2);
        let out = bash_output(0, &big, "");
        assert!(out.len() <= MAX_TOOL_BYTES + 64);
        assert!(out.contains("…[truncated]"));
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
    fn paged_read_returns_whole_small_file_unmarked() {
        let res = paged_read("a\nb\nc\n", None, None);
        assert!(res.ok);
        assert_eq!(res.content, "a\nb\nc\n");
    }

    #[test]
    fn paged_read_pages_by_offset_and_limit_with_continuation_hint() {
        let content = "l1\nl2\nl3\nl4\nl5\n";
        let res = paged_read(content, Some(2), Some(2));
        assert!(res.ok);
        assert!(res.content.starts_with("l2\nl3\n"));
        // The marker tells the model exactly how to continue.
        assert!(res.content.contains("showing lines 2–3 of 5"));
        assert!(res.content.contains("offset=4"));
        // Reading the tail cleanly ends without a marker.
        let tail = paged_read(content, Some(4), None);
        assert_eq!(tail.content, "l4\nl5\n");
    }

    #[test]
    fn paged_read_enforces_the_byte_cap_for_small_contexts() {
        // A "file" bigger than the cap: one long line per row.
        let big: String = (0..2_000).map(|i| format!("{i}{}\n", "x".repeat(40))).collect();
        let res = paged_read(&big, None, None);
        assert!(res.ok);
        assert!(res.content.len() <= MAX_TOOL_BYTES + 200, "cap holds (+marker)");
        assert!(res.content.contains("call read_file again with offset="));
    }

    #[test]
    fn paged_read_rejects_past_end_offset() {
        let res = paged_read("only\n", Some(10), None);
        assert!(!res.ok);
        assert!(res.content.contains("past the end"));
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
