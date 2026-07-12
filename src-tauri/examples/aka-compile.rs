//! Dev harness for the agent compiler: compile a spec file against a project
//! dir from the command line and print the outcome. This is the Stage-4 proof
//! runner — it exercises the exact `compiler::compile` path the Tauri command
//! wraps, without needing the app shell. Not part of any bundle.
//!
//!   cargo run --example aka-compile -- <project-dir> <spec-file> [known-model…]

use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [project, spec_path, known @ ..] = args.as_slice() else {
        eprintln!("usage: aka-compile <project-dir> <spec-file> [known-model…]");
        return ExitCode::from(2);
    };

    let spec_text = match std::fs::read_to_string(spec_path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("read {spec_path}: {e}");
            return ExitCode::from(2);
        }
    };
    // CLI-supplied names become a local-only catalog (no fingerprints, no
    // runtime query) — enough to exercise the validation paths from a shell.
    let catalog = (!known.is_empty()).then(|| aka_lib::compiler::ModelCatalog {
        local: known
            .iter()
            .map(|id| aka_lib::compiler::ModelInfo { id: id.clone(), fingerprint: String::new() })
            .collect(),
        remote: None,
    });

    match aka_lib::compiler::compile(Path::new(project), &spec_text, catalog.as_ref()) {
        Ok(outcome) => {
            println!(
                "bundle {}  cache_hit={}",
                outcome.bundle_hash, outcome.cache_hit
            );
            println!("manifest: {}", outcome.manifest_path);
            for n in &outcome.nodes {
                println!("  node {:<8} {:?}  {}", n.id, n.status, n.hash);
            }
            for w in &outcome.warnings {
                println!("warning: {w}");
            }
            if outcome.pruned > 0 {
                println!("pruned {} superseded artifact dir(s)", outcome.pruned);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("compile error:\n{e}");
            ExitCode::FAILURE
        }
    }
}
