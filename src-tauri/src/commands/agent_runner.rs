use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::commands::project_config::{load_from_disk, AgentBlock, RuntimeBlock};
use crate::error::AppError;
use crate::sandbox::{assert_within_sandbox, SandboxState};

const STDERR_TAIL_LINES: usize = 20;
/// How long the agent's output must be quiet, while the last (unterminated) line
/// looks like a prompt, before we treat it as a question awaiting the user.
const QUESTION_IDLE: Duration = Duration::from_millis(400);
/// Don't treat an absurdly long unterminated line as a prompt (progress spew).
const MAX_PROMPT_LEN: usize = 400;

/// Result of probing a single user-registered agent binary on PATH. AKA ships
/// no agent catalog — the caller supplies the bins to probe (the user's saved
/// agents), and we only report whether each is present and its version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub bin: String,
    pub installed: bool,
    pub version: Option<String>,
}

/// One attachment the user pinned to the task, as handed from the frontend.
/// Threaded into the spawned agent's env (`AKA_ATTACHMENTS`) so a vision- or
/// file-aware agent can locate the files AKA can't inject into the agent's own
/// model call. Round-trips verbatim — AKA never inspects which kind it is.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub name: String,
    /// "file" | "folder" | "image" | "url".
    pub kind: String,
    /// Absolute filesystem path (file/folder/image); absent for URLs.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinePayload {
    run_id: String,
    line: String,
    stream: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    run_id: String,
    exit_code: i32,
}

/// Emitted when the agent appears to be waiting on an interactive answer. The
/// detection is fully generic (prompt-shaped trailing text + an idle pause) —
/// it never looks at which agent is running.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuestionPayload {
    run_id: String,
    prompt: String,
    /// "confirm" → yes/no (Approve/Reject); "input" → free-text reply.
    kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    run_id: String,
    /// "running" | "paused".
    state: &'static str,
}

const EVT_OUTPUT: &str = "agent://output";
const EVT_DONE: &str = "agent://done";
const EVT_QUESTION: &str = "agent://question";
/// Lifecycle transitions the UI reflects (running ↔ paused).
const EVT_STATE: &str = "agent://state";

#[cfg(unix)]
const SIG_STOP: i32 = libc::SIGSTOP;
#[cfg(unix)]
const SIG_CONT: i32 = libc::SIGCONT;
#[cfg(not(unix))]
const SIG_STOP: i32 = 0;
#[cfg(not(unix))]
const SIG_CONT: i32 = 0;

/// Deliver `sig` to the agent's process group (negative pid) so the agent and
/// any children it spawned stop/continue together — the PTY slave spawn makes
/// the child a session leader, so its pgid equals its pid. Falls back to the
/// single process if the group send fails. No-op (returns false) off Unix.
#[cfg(unix)]
fn send_signal(pid: u32, sig: i32) -> bool {
    let pid = pid as i32;
    unsafe {
        if libc::kill(-pid, sig) == 0 {
            return true;
        }
        libc::kill(pid, sig) == 0
    }
}

#[cfg(not(unix))]
fn send_signal(_pid: u32, _sig: i32) -> bool {
    false
}

/// One end of the PTY-thread handshake: the killer, the stdin writer, and the
/// child's pid (for pause/resume signals).
type SetupOk = (
    Box<dyn ChildKiller + Send + Sync>,
    Box<dyn Write + Send>,
    Option<u32>,
);

/// Per-run handles. AKA spawns every agent inside a pseudo-terminal so tools
/// that expect a TTY (prompt_toolkit, readline, …) work and can be answered.
struct RunHandle {
    /// Kills the child from another thread (e.g. `stop_agent`).
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Writes to the PTY master — i.e. types into the agent's stdin. Shared so
    /// `answer_agent` can deliver the user's reply while the read loop runs.
    writer: Arc<std::sync::Mutex<Box<dyn Write + Send>>>,
    /// The child's pid, used to deliver pause/resume signals. `None` if the
    /// PTY backend couldn't report one.
    pid: Option<u32>,
    /// Whether the run is currently SIGSTOP-suspended.
    paused: bool,
}

#[derive(Default)]
pub struct RunnerState {
    /// Live runs keyed by run id. An entry exists only while a run is in flight;
    /// keying by run id lets independent sessions run, be answered, and be
    /// stopped concurrently without sharing one lock.
    runs: Arc<Mutex<HashMap<String, RunHandle>>>,
}

fn resolve_args(
    args: &[String],
    runtime: &RuntimeBlock,
    model: &str,
    task: &str,
) -> Vec<String> {
    args.iter()
        .map(|a| {
            a.replace("{model}", model)
                .replace("{base_url}", &runtime.base_url)
                .replace("{task}", task)
        })
        .collect()
}

/// Strip ANSI/VT escape sequences so a PTY stream renders as clean text in the
/// transcript. Conservative: drops CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`),
/// and other `ESC x` two-byte sequences. Carriage returns are intentionally
/// PRESERVED here so `collapse_cr` can apply terminal redraw semantics to them
/// — stripping them outright concatenates every frame of a `\r`-based spinner
/// into one run-on line.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if ('\x40'..='\x7e').contains(&n) {
                            break; // CSI final byte
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if n == '\x07' {
                            break; // BEL terminates OSC
                        }
                        if n == '\x1b' {
                            if chars.peek().copied() == Some('\\') {
                                chars.next();
                            }
                            break; // ST terminates OSC
                        }
                    }
                }
                Some(_) => {
                    chars.next(); // two-byte ESC sequence, e.g. `ESC ( B`
                }
                None => {}
            },
            _ => out.push(c),
        }
    }
    out
}

/// Apply terminal carriage-return semantics to a single line: `\r` returns the
/// cursor to column 0, and subsequent characters overwrite what's there. This
/// collapses a `\r`-redrawn progress spinner ("Waiting… 0.1s\rWaiting… 0.2s\r…")
/// down to just its final frame, instead of leaving every frame concatenated.
/// A trailing `\r` (cursor parked at col 0 with nothing after) leaves the line
/// intact, matching what a terminal actually shows.
fn collapse_cr(input: &str) -> String {
    if !input.contains('\r') {
        return input.to_string();
    }
    let mut buf: Vec<char> = Vec::with_capacity(input.len());
    let mut cursor = 0usize;
    for c in input.chars() {
        match c {
            '\r' => cursor = 0,
            _ => {
                if cursor < buf.len() {
                    buf[cursor] = c;
                } else {
                    buf.push(c);
                }
                cursor += 1;
            }
        }
    }
    buf.into_iter().collect()
}

/// Classify a trailing (unterminated) output line as an interactive prompt, or
/// `None` if it doesn't look like one. Fully generic — no agent-specific text;
/// just the shapes CLIs use to ask for input. Returns "confirm" for yes/no
/// prompts (Approve/Reject) and "input" for free-text prompts.
fn classify_prompt(partial: &str) -> Option<&'static str> {
    let clean = collapse_cr(&strip_ansi(partial));
    let trimmed = clean.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PROMPT_LEN {
        return None;
    }
    let lower = trimmed.to_lowercase();

    // Yes/no confirmations across their many shapes — matching the y/n token
    // (case-insensitive) keeps this broad yet precise:
    //   (y/n)  [Y/n]  (y/N)  (yes/no)  (y/n/all)  "(Y)es/(N)o"  "Proceed? [y/N]"
    let confirm = lower.contains("y/n")
        || lower.contains("yes/no")
        || lower.contains("y/yes")
        || (lower.contains("(y)") && lower.contains("(n)")) // "(Y)es/(N)o" option lists
        || (lower.contains("[y]") && lower.contains("[n]"))
        || lower.ends_with("? y")
        || lower.ends_with("?y");
    if confirm {
        return Some("confirm");
    }

    // A trailing question mark is the strongest free-text signal.
    if trimmed.ends_with('?') {
        return Some("input");
    }
    // A trailing colon or prompt cursor also means "type something" — unless the
    // line is progress spew (download bars never emit a newline, so they pile up
    // as a partial too and must not be mistaken for a prompt).
    let looks_progress = trimmed.ends_with("...")
        || trimmed.ends_with('…')
        || trimmed.ends_with('%')
        || trimmed.contains('█')
        || trimmed.contains('▓')
        || trimmed.contains('▒');
    if !looks_progress
        && (trimmed.ends_with(':')
            || trimmed.ends_with('>')
            || trimmed.ends_with('›')
            || trimmed.ends_with('»'))
    {
        return Some("input");
    }
    None
}

/// Launch the agent configured for `project_path`. Loads the project's
/// `config.json` fresh — config is never cached between runs.
///
/// The agent runs inside a pseudo-terminal (so it can prompt) with the run's
/// output streamed as `agent://output` and interactive prompts surfaced as
/// `agent://question`. Returns `AppError::AgentCrash` on a non-zero exit, with
/// the tail of output for the UI.
#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    state: State<'_, RunnerState>,
    sandbox: State<'_, SandboxState>,
    checkpoints: State<'_, crate::commands::checkpoints::CheckpointState>,
    task: String,
    project_path: String,
    run_id: Option<String>,
    // Live model/runtime values from the frontend. When present these override
    // what `load_from_disk` reads, eliminating the async write-before-read race
    // that could cause a just-switched model to be ignored on the first run.
    model_override: Option<String>,
    base_url_override: Option<String>,
    api_key_override: Option<String>,
    // Image attachments pinned to this task, by absolute path. AKA can't inject
    // them into the agent's own model call (the agent is a separate process that
    // makes its own LLM calls), so it hands the FILES to the agent instead.
    image_paths: Option<Vec<String>>,
    // All attachments for this task ({ name, kind, path }), so an agent that
    // wants richer context than the image paths alone can find them.
    attachments: Option<Vec<AttachmentMeta>>,
) -> Result<(), AppError> {
    if project_path.trim().is_empty() {
        return Err(AppError::sandbox(project_path.clone()));
    }

    let sb = sandbox
        .require()
        .await
        .map_err(|_| AppError::sandbox(project_path.clone()))?;
    assert_within_sandbox(Path::new(&project_path), &sb)?;

    let mut cfg = load_from_disk(&project_path).await?;
    // Apply live overrides from the frontend so a model the user just switched
    // to is honoured even if its async disk write hasn't flushed yet (the
    // write-before-read race). Absent overrides fall back to the disk values.
    if let Some(model) = model_override {
        cfg.runtime.model = model;
    }
    if let Some(base_url) = base_url_override {
        cfg.runtime.base_url = base_url;
    }
    if let Some(api_key) = api_key_override {
        cfg.runtime.api_key = Some(api_key);
    }
    let agent: AgentBlock = cfg.agent;
    if agent.bin.trim().is_empty() {
        return Err(AppError::AgentCrash {
            exit_code: -1,
            stderr: "agent.bin is not configured for this project (.äkä/config.json)".into(),
        });
    }

    // AKA is agent-agnostic: the runner never inspects which agent this is or
    // rewrites its args/model. Saved `agent.args` are used verbatim, with only
    // `{model}` / `{base_url}` / `{task}` substituted.
    let resolved = resolve_args(&agent.args, &cfg.runtime, &cfg.runtime.model, &task);

    // Spill the prompt to a temp file so `AKA_TASK_FILE` works for large prompts.
    let task_file: PathBuf = {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("aka-task-{}-{}.txt", std::process::id(), nanos))
    };
    let task_file_ok = tokio::fs::write(&task_file, task.as_bytes()).await.is_ok();

    // Resolve the bin to an absolute path the way the user's terminal would.
    let bin_for_resolve = agent.bin.clone();
    let program = tokio::task::spawn_blocking(move || crate::path_env::resolve_bin(&bin_for_resolve))
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| agent.bin.clone());

    // Build the child env: inherit the (PATH-repaired) process env, then layer
    // the stable AKA contract on top — exported identically to every agent.
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let api_key = cfg.runtime.api_key.clone().unwrap_or_default();
    env.insert("AKA_MODEL".into(), cfg.runtime.model.clone());
    env.insert("AKA_BASE_URL".into(), cfg.runtime.base_url.clone());
    env.insert("AKA_API_KEY".into(), api_key.clone());
    env.insert("AKA_PROJECT_DIR".into(), project_path.clone());
    env.insert("AKA_TASK".into(), task.clone());
    if task_file_ok {
        env.insert("AKA_TASK_FILE".into(), task_file.to_string_lossy().into_owned());
    }
    // Attachment contract — give vision/file-aware agents the files AKA can't
    // inject into their own model call:
    //   AKA_IMAGE_PATHS  newline-separated absolute paths of attached images
    //   AKA_ATTACHMENTS  JSON array of { name, kind, path } for ALL attachments
    // Both are omitted when the task has none, so attachment-free runs are
    // byte-for-byte unchanged and agents that ignore them keep working.
    if let Some(paths) = image_paths {
        let paths: Vec<String> = paths.into_iter().filter(|p| !p.trim().is_empty()).collect();
        if !paths.is_empty() {
            env.insert("AKA_IMAGE_PATHS".into(), paths.join("\n"));
        }
    }
    if let Some(attachments) = attachments {
        if !attachments.is_empty() {
            if let Ok(json) = serde_json::to_string(&attachments) {
                env.insert("AKA_ATTACHMENTS".into(), json);
            }
        }
    }
    env.insert("OPENAI_BASE_URL".into(), cfg.runtime.base_url.clone());
    env.insert("OPENAI_API_BASE".into(), cfg.runtime.base_url.clone());
    env.insert(
        "OPENAI_API_KEY".into(),
        if api_key.is_empty() { "nokey".into() } else { api_key.clone() },
    );

    let run_id = run_id.unwrap_or_else(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("run-{}-{}", std::process::id(), nanos)
    });

    // Snapshot the working tree before the agent can touch it — the baseline a
    // rollback or restart returns to. Best-effort; a silent no-op outside a git
    // repo, and never allowed to block the run.
    let _ = crate::commands::checkpoints::create_checkpoint_inner(
        &app,
        checkpoints.inner(),
        &project_path,
        &run_id,
        "Before run",
        "prerun",
    )
    .await;
    // The thread below moves `project_path`; keep a copy for the post-run snapshot.
    let project_path_post = project_path.clone();

    // The PTY lifecycle is blocking, so it lives on a dedicated OS thread. It
    // hands the killer + writer back over `setup_rx` (for state registration),
    // then drives the read/detect loop and reports the exit code over `done_rx`.
    let (setup_tx, setup_rx) = oneshot::channel::<Result<SetupOk, String>>();
    let (done_tx, done_rx) = oneshot::channel::<(i32, String)>();

    let app_thread = app.clone();
    let rid_thread = run_id.clone();
    let program_err = program.clone();
    std::thread::spawn(move || {
        let pty = native_pty_system();
        let pair = match pty.openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 }) {
            Ok(p) => p,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("open pty: {e}")));
                return;
            }
        };

        let mut builder = CommandBuilder::new(&program);
        for arg in &resolved {
            builder.arg(arg);
        }
        builder.cwd(&project_path);
        for (k, v) in &env {
            builder.env(k, v);
        }

        let mut child = match pair.slave.spawn_command(builder) {
            Ok(c) => c,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("failed to spawn {program_err}: {e}")));
                return;
            }
        };
        // Drop the slave so the master EOFs once the child exits.
        drop(pair.slave);

        let killer = child.clone_killer();
        let pid = child.process_id();
        let writer = match pair.master.take_writer() {
            Ok(w) => w,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("pty writer: {e}")));
                return;
            }
        };
        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                let _ = setup_tx.send(Err(format!("pty reader: {e}")));
                return;
            }
        };
        if setup_tx.send(Ok((killer, writer, pid))).is_err() {
            return; // run_agent gave up before we registered — nothing to do
        }
        // Keep the master alive for the whole run (dropping it closes the fds).
        let _master = pair.master;

        // Reader thread: blocking-reads the PTY and forwards raw chunks so the
        // processor below can use recv_timeout to detect "idle at a prompt".
        let (chunk_tx, chunk_rx) = mpsc::channel::<Vec<u8>>();
        let reader_handle = std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if chunk_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut pending: Vec<u8> = Vec::new();
        let mut tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_LINES + 1);
        let mut last_question: Option<String> = None;

        let emit_line = |line: String, tail: &mut VecDeque<String>| {
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line.clone());
            let _ = app_thread.emit(
                EVT_OUTPUT,
                LinePayload { run_id: rid_thread.clone(), line, stream: "stdout" },
            );
        };

        loop {
            match chunk_rx.recv_timeout(QUESTION_IDLE) {
                Ok(bytes) => {
                    pending.extend_from_slice(&bytes);
                    // Drain complete lines.
                    let mut emitted_any = false;
                    while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                        let raw: Vec<u8> = pending.drain(..=pos).collect();
                        let line = collapse_cr(&strip_ansi(&String::from_utf8_lossy(&raw)));
                        let line = line.trim_end_matches('\n').to_string();
                        emit_line(line, &mut tail);
                        emitted_any = true;
                    }
                    // Progress means any earlier prompt was answered/superseded.
                    if emitted_any {
                        last_question = None;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // Output went quiet. If the trailing partial looks like a
                    // prompt we haven't already surfaced, raise a question.
                    if !pending.is_empty() {
                        let partial = String::from_utf8_lossy(&pending).to_string();
                        if let Some(kind) = classify_prompt(&partial) {
                            let prompt = strip_ansi(&partial).trim().to_string();
                            if last_question.as_deref() != Some(prompt.as_str()) {
                                last_question = Some(prompt.clone());
                                let _ = app_thread.emit(
                                    EVT_QUESTION,
                                    QuestionPayload { run_id: rid_thread.clone(), prompt, kind },
                                );
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break, // EOF
            }
        }

        // Flush any trailing partial as a final line.
        if !pending.is_empty() {
            let line = collapse_cr(&strip_ansi(&String::from_utf8_lossy(&pending)));
            let line = line.trim_end_matches('\n').to_string();
            if !line.is_empty() {
                emit_line(line, &mut tail);
            }
        }

        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
        let _ = reader_handle.join();
        let tail_str = tail.iter().cloned().collect::<Vec<_>>().join("\n");
        let _ = done_tx.send((code, tail_str));
    });

    // Register the run so answer_agent / stop_agent can reach it.
    match setup_rx.await {
        Ok(Ok((killer, writer, pid))) => {
            let mut runs = state.runs.lock().await;
            runs.insert(
                run_id.clone(),
                RunHandle {
                    killer,
                    writer: Arc::new(std::sync::Mutex::new(writer)),
                    pid,
                    paused: false,
                },
            );
        }
        Ok(Err(e)) => {
            if task_file_ok {
                let _ = tokio::fs::remove_file(&task_file).await;
            }
            return Err(AppError::AgentCrash { exit_code: -1, stderr: e });
        }
        Err(_) => {
            return Err(AppError::AgentCrash {
                exit_code: -1,
                stderr: "agent process failed to start".into(),
            });
        }
    }

    let (exit_code, tail) = done_rx.await.unwrap_or((-1, String::new()));

    {
        let mut runs = state.runs.lock().await;
        runs.remove(&run_id);
    }
    if task_file_ok {
        let _ = tokio::fs::remove_file(&task_file).await;
    }

    // Snapshot the final state so the run's result stays restorable even after
    // the user makes further edits. Best-effort.
    let _ = crate::commands::checkpoints::create_checkpoint_inner(
        &app,
        checkpoints.inner(),
        &project_path_post,
        &run_id,
        "After run",
        "postrun",
    )
    .await;

    let _ = app.emit(EVT_DONE, DonePayload { run_id: run_id.clone(), exit_code });

    if exit_code != 0 {
        return Err(AppError::AgentCrash { exit_code, stderr: tail });
    }
    Ok(())
}

/// Deliver a user's answer to a waiting agent — types `text` (+ newline) into
/// the run's PTY. Returns false if the run isn't live.
#[tauri::command]
pub async fn answer_agent(
    state: State<'_, RunnerState>,
    run_id: String,
    text: String,
) -> Result<bool, String> {
    let writer = {
        let runs = state.runs.lock().await;
        runs.get(&run_id).map(|h| h.writer.clone())
    };
    match writer {
        Some(w) => {
            let line = if text.ends_with('\n') { text } else { format!("{text}\n") };
            let mut guard = w.lock().map_err(|_| "pty writer poisoned".to_string())?;
            guard.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            guard.flush().map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Suspend a running agent (and its child processes) with SIGSTOP. Returns
/// false if the run isn't live, has no pid, or the platform is unsupported
/// (non-Unix). Emits `agent://state` "paused" on success.
#[tauri::command]
pub async fn pause_agent(
    app: AppHandle,
    state: State<'_, RunnerState>,
    run_id: String,
) -> Result<bool, String> {
    let mut runs = state.runs.lock().await;
    let handle = match runs.get_mut(&run_id) {
        Some(h) => h,
        None => return Ok(false),
    };
    let pid = match handle.pid {
        Some(p) => p,
        None => return Ok(false),
    };
    let ok = send_signal(pid, SIG_STOP);
    if ok {
        handle.paused = true;
        let _ = app.emit(
            EVT_STATE,
            StatePayload { run_id: run_id.clone(), state: "paused" },
        );
    }
    Ok(ok)
}

/// Resume a SIGSTOP-suspended agent with SIGCONT. Returns false if the run
/// isn't live / has no pid / unsupported platform. Emits `agent://state`
/// "running" on success.
#[tauri::command]
pub async fn resume_agent(
    app: AppHandle,
    state: State<'_, RunnerState>,
    run_id: String,
) -> Result<bool, String> {
    let mut runs = state.runs.lock().await;
    let handle = match runs.get_mut(&run_id) {
        Some(h) => h,
        None => return Ok(false),
    };
    let pid = match handle.pid {
        Some(p) => p,
        None => return Ok(false),
    };
    let ok = send_signal(pid, SIG_CONT);
    if ok {
        handle.paused = false;
        let _ = app.emit(
            EVT_STATE,
            StatePayload { run_id: run_id.clone(), state: "running" },
        );
    }
    Ok(ok)
}

#[tauri::command]
pub async fn stop_agent(
    state: State<'_, RunnerState>,
    run_id: Option<String>,
) -> Result<bool, String> {
    let mut runs = state.runs.lock().await;
    match run_id {
        Some(id) => match runs.remove(&id) {
            Some(mut h) => {
                let _ = h.killer.kill();
                Ok(true)
            }
            None => Ok(false),
        },
        None => {
            let any = !runs.is_empty();
            for (_, mut h) in runs.drain() {
                let _ = h.killer.kill();
            }
            Ok(any)
        }
    }
}

async fn probe_agent(bin: String) -> DetectedAgent {
    // Resolve to an absolute path the way the user's terminal would (process
    // PATH first, then a login-shell fallback). Possibly a shell call, so push
    // it to a blocking thread to keep the concurrent probe non-blocking.
    let bin_for_resolve = bin.clone();
    let resolved = tokio::task::spawn_blocking(move || crate::path_env::resolve_bin(&bin_for_resolve))
        .await
        .ok()
        .flatten();

    let (installed, version) = match &resolved {
        Some(path) => {
            let output = Command::new(path)
                .arg("--version")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await;
            let v = output.ok().and_then(|o| {
                let raw = if !o.stdout.is_empty() { o.stdout } else { o.stderr };
                let s = String::from_utf8_lossy(&raw).to_string();
                s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
            });
            (true, v)
        }
        None => (false, None),
    };

    DetectedAgent { bin, installed, version }
}

/// Probe a caller-supplied set of bins concurrently. The bins come from the
/// user's own registered agents — AKA has no built-in list to scan.
async fn probe_bins(bins: Vec<String>) -> Vec<DetectedAgent> {
    let probes = bins.into_iter().map(probe_agent);
    futures::future::join_all(probes).await
}

#[tauri::command]
pub async fn detect_agents(bins: Vec<String>) -> Vec<DetectedAgent> {
    probe_bins(bins).await
}

#[tauri::command]
pub async fn recheck_agents(bins: Vec<String>) -> Vec<DetectedAgent> {
    probe_bins(bins).await
}

#[cfg(test)]
mod tests {
    use super::{classify_prompt, strip_ansi};

    #[test]
    fn detects_yes_no_confirmations() {
        for p in [
            "Add cwd to git? (y/N) ",
            "Proceed? [Y/n]",
            "Overwrite file.txt? (yes/no)",
            "Run shell command? (y/n/all)",
            "Allow edits to main.py? (Y)es/(N)o/(D)on't ask",
            "\x1b[1mCommit changes?\x1b[0m (y/n)", // with ANSI styling
            "Apply this diff? [y/N]: ",
        ] {
            assert_eq!(classify_prompt(p), Some("confirm"), "expected confirm: {p:?}");
        }
    }

    #[test]
    fn detects_free_text_prompts() {
        for p in [
            "What should the commit message be? ",
            "Enter your name: ",
            "Select a model: ",
            "Choose a branch:",
            "> ",
            "aider› ",
        ] {
            assert_eq!(classify_prompt(p), Some("input"), "expected input: {p:?}");
        }
    }

    #[test]
    fn ignores_non_prompts_and_progress() {
        for p in [
            "",
            "Reading project files",
            "Downloading model... ",
            "Cloning repository…",
            "Progress: 42%",
            "Applied edit to main.py",
            "████████░░ 80%",
            "▓▓▓▓ building",
        ] {
            assert_eq!(classify_prompt(p), None, "expected no prompt: {p:?}");
        }
    }

    #[test]
    fn ignores_overly_long_lines() {
        let long = "x".repeat(600) + "?";
        assert_eq!(classify_prompt(&long), None);
    }

    #[test]
    fn strips_ansi_but_preserves_carriage_returns() {
        assert_eq!(strip_ansi("\x1b[31mhello\x1b[0m"), "hello");
        // `\r` is now preserved for collapse_cr to handle (not stripped here).
        assert_eq!(strip_ansi("a\rb"), "a\rb");
        assert_eq!(strip_ansi("\x1b]0;title\x07done"), "done"); // OSC
    }

    #[test]
    fn collapse_cr_redraws_to_final_frame() {
        use super::collapse_cr;
        // The exact spinner flood we saw: every `\r` frame collapses to the last.
        assert_eq!(
            collapse_cr("Waiting for model... 0.1s\rWaiting for model... 0.2s"),
            "Waiting for model... 0.2s"
        );
        // Cursor overwrite leaves a longer tail in place (terminal-accurate).
        assert_eq!(collapse_cr("Longtext\rSho"), "Shogtext");
        // Plain overwrite.
        assert_eq!(collapse_cr("a\rb"), "b");
        // Trailing CR with nothing after leaves the content intact.
        assert_eq!(collapse_cr("done\r"), "done");
        // No CR is a cheap pass-through.
        assert_eq!(collapse_cr("no carriage returns"), "no carriage returns");
    }
}
