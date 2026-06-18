//! `aka-tool` — AKA's self-contained tool shim.
//!
//! AKA puts this binary's directory on a spawned agent's PATH (see
//! `commands::agent_runner`) so any agent that can run a shell command can call
//! AKA's built-in tools, e.g. `aka-tool diagnostics`. The shim runs each tool
//! itself — no IPC back to the host — and prints a single JSON object to stdout.
//!
//! Exit code is about the *shim*, not the findings: a successful run is exit 0
//! even when diagnostics report errors (the findings live in the JSON, keyed by
//! `ok`/`errors`/`diagnostics`). The shim exits non-zero only when it cannot do
//! its job (unknown subcommand, unconfigured command, spawn failure).
//!
//! The tool *names* come from the shared catalog (included below) so they can't
//! drift from what the host advertises.

#[path = "../tools/catalog.rs"]
mod catalog;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// Cap on the raw passthrough output echoed back, so a noisy build can't flood
/// the agent's context. Structured `diagnostics` are never truncated.
const RAW_CAP: usize = 16_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let sub = args.first().map(String::as_str).unwrap_or("");
    let rest: &[String] = args.get(1..).unwrap_or(&[]);

    let code = match sub {
        "diagnostics" => run_diagnostics(rest),
        "list" => {
            print_json(&catalog::builtin_tools());
            0
        }
        "" | "help" | "-h" | "--help" => {
            print_help();
            0
        }
        other => {
            print_json(&ShimError {
                ok: false,
                tool: None,
                error: format!("unknown tool '{other}' — try `aka-tool list`"),
            });
            2
        }
    };
    std::process::exit(code);
}

// ---------- project + config ----------

/// Resolve the project root: `--project <path>` wins, else `$AKA_PROJECT_DIR`
/// (what the host exports to every agent), else the current directory.
fn project_dir(rest: &[String]) -> PathBuf {
    if let Some(i) = rest.iter().position(|a| a == "--project") {
        if let Some(p) = rest.get(i + 1) {
            return PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("AKA_PROJECT_DIR") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[derive(serde::Deserialize, Default)]
struct ShimConfig {
    #[serde(default)]
    agent: ShimAgent,
}

#[derive(serde::Deserialize, Default)]
struct ShimAgent {
    #[serde(default)]
    diagnostics_cmd: String,
}

/// Read `<project>/.äkä/config.json`, ignoring every field but the one this
/// tool needs. A missing/empty/corrupt file yields defaults — the caller then
/// reports "not configured" rather than crashing.
fn load_config(project: &Path) -> ShimConfig {
    let path = project.join(".äkä").join("config.json");
    match std::fs::read(&path) {
        Ok(bytes) if !bytes.is_empty() => serde_json::from_slice(&bytes).unwrap_or_default(),
        _ => ShimConfig::default(),
    }
}

// ---------- diagnostics ----------

#[derive(Serialize)]
struct Diagnostic {
    file: String,
    line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    col: Option<u32>,
    severity: String,
    message: String,
}

#[derive(Serialize)]
struct DiagResult {
    ok: bool,
    tool: &'static str,
    exit_code: i32,
    errors: usize,
    warnings: usize,
    diagnostics: Vec<Diagnostic>,
    #[serde(skip_serializing_if = "str::is_empty")]
    raw: String,
}

#[derive(Serialize)]
struct ShimError {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<&'static str>,
    error: String,
}

fn run_diagnostics(rest: &[String]) -> i32 {
    let project = match project_dir(rest).canonicalize() {
        Ok(p) => p,
        Err(e) => {
            print_json(&ShimError {
                ok: false,
                tool: Some("diagnostics"),
                error: format!("project dir not found: {e}"),
            });
            return 1;
        }
    };

    let cmd = load_config(&project).agent.diagnostics_cmd.trim().to_string();
    if cmd.is_empty() {
        print_json(&ShimError {
            ok: false,
            tool: Some("diagnostics"),
            error: "no diagnostics_cmd configured (set agent.diagnostics_cmd in .äkä/config.json)"
                .into(),
        });
        return 1;
    }

    let mut parts = cmd.split_whitespace();
    let bin = parts.next().unwrap_or_default().to_string();
    let cmd_args: Vec<&str> = parts.collect();

    let output = match Command::new(&bin)
        .args(&cmd_args)
        .current_dir(&project)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            print_json(&ShimError {
                ok: false,
                tool: Some("diagnostics"),
                error: format!("failed to run diagnostics_cmd '{cmd}': {e}"),
            });
            return 1;
        }
    };

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.stderr.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    let combined = combined.trim_end().to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    let diagnostics = parse_diagnostics(&combined);
    let errors = diagnostics.iter().filter(|d| d.severity == "error").count();
    let warnings = diagnostics.iter().filter(|d| d.severity == "warning").count();

    let raw = if combined.len() > RAW_CAP {
        let mut t: String = combined.chars().take(RAW_CAP).collect();
        t.push_str("\n…[truncated]");
        t
    } else {
        combined
    };

    print_json(&DiagResult {
        ok: true,
        tool: "diagnostics",
        exit_code,
        errors,
        warnings,
        diagnostics,
        raw,
    });
    0
}

/// Best-effort structured extraction over the two near-universal compiler/linter
/// shapes. Anything unmatched is still returned verbatim in `raw`, so nothing is
/// lost — this only *adds* structure on top.
fn parse_diagnostics(output: &str) -> Vec<Diagnostic> {
    use regex::Regex;
    // tsc style: `src/foo.ts(12,5): error TS2304: Cannot find name 'x'.`
    let re_paren = Regex::new(
        r"^\s*(?P<file>[^\s(][^(]*?)\((?P<line>\d+),(?P<col>\d+)\):\s*(?P<sev>error|warning)\s+\S+:?\s*(?P<msg>.+?)\s*$",
    )
    .unwrap();
    // gcc/clang/eslint-compact/ruff/flake8 style: `path:line[:col]: [sev:] message`
    let re_colon = Regex::new(
        r"^\s*(?P<file>[^\s:][^:]*?):(?P<line>\d+)(?::(?P<col>\d+))?:\s*(?:(?P<sev>error|warning|note|info)\b:?\s*)?(?P<msg>.+?)\s*$",
    )
    .unwrap();

    let mut out = Vec::new();
    for line in output.lines() {
        let Some(caps) = re_paren.captures(line).or_else(|| re_colon.captures(line)) else {
            continue;
        };
        let message = caps.name("msg").map(|m| m.as_str().to_string()).unwrap_or_default();
        if message.is_empty() {
            continue;
        }
        out.push(Diagnostic {
            file: caps.name("file").map(|m| m.as_str().to_string()).unwrap_or_default(),
            line: caps.name("line").and_then(|m| m.as_str().parse().ok()).unwrap_or(0),
            col: caps.name("col").and_then(|m| m.as_str().parse().ok()),
            severity: caps
                .name("sev")
                .map(|m| normalize_sev(m.as_str()))
                // A file:line line with no explicit severity (e.g. a ruff code)
                // is treated as an error — it's a reported problem either way.
                .unwrap_or_else(|| "error".to_string()),
            message,
        });
    }
    out
}

fn normalize_sev(s: &str) -> String {
    match s.to_ascii_lowercase().as_str() {
        "error" => "error",
        "warning" => "warning",
        _ => "info",
    }
    .to_string()
}

// ---------- output ----------

fn print_json<T: Serialize>(v: &T) {
    match serde_json::to_string_pretty(v) {
        Ok(s) => println!("{s}"),
        Err(e) => println!("{{\"ok\":false,\"error\":\"serialize: {e}\"}}"),
    }
}

fn print_help() {
    eprintln!(
        "aka-tool — AKA built-in tool shim\n\n\
         Usage:\n  aka-tool <tool> [args]\n\n\
         Tools:\n  \
         diagnostics   run the project's configured typecheck/lint (agent.diagnostics_cmd)\n  \
         list          print the built-in tool catalog as JSON\n\n\
         Project: --project <path> | $AKA_PROJECT_DIR | current dir\n\
         Output:  one JSON object on stdout; exit is non-zero only on shim failure."
    );
}
