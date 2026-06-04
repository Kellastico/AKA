//! Repair the process `PATH` for GUI launches, and resolve binaries the way the
//! user's terminal would.
//!
//! A macOS app launched from Finder/Dock (and Linux desktop launchers) inherits
//! a minimal `PATH` — typically `/usr/bin:/bin:/usr/sbin:/sbin` — that omits
//! Homebrew, pyenv/asdf, Cargo, npm-global, and pip `--user` bin dirs. That's
//! where user-installed agents live (e.g. `aider` in `~/Library/Python/3.9/bin`),
//! so naive `which`/spawn can't find binaries the user clearly has in their
//! terminal.
//!
//! Two parts:
//!   * [`fix`] rebuilds `PATH` at startup from the login shell + well-known dirs.
//!   * [`resolve_bin`] resolves a command to an absolute path, falling back to
//!     asking the login shell directly — so even if `fix` missed a dir, an agent
//!     that runs in the user's terminal still resolves here.

use std::path::PathBuf;

/// Rebuild and set the process `PATH`. No-op on non-unix targets, where GUI
/// apps already inherit a usable `PATH`.
pub fn fix() {
    #[cfg(unix)]
    unix::fix();
}

/// Resolve a command to an absolute path the way the user's terminal would.
/// Tries the (already-repaired) process `PATH` first; on a miss, asks the user's
/// login shell (`command -v`). Returns `None` only when the binary genuinely
/// can't be found anywhere the user's shell would look.
pub fn resolve_bin(bin: &str) -> Option<PathBuf> {
    if bin.trim().is_empty() {
        return None;
    }
    // An explicit path (absolute or relative): trust it when it exists, else
    // let `which` validate/normalise it.
    if bin.contains('/') {
        let p = PathBuf::from(bin);
        if p.exists() {
            return Some(p);
        }
        return which::which(bin).ok();
    }
    if let Ok(p) = which::which(bin) {
        return Some(p);
    }
    #[cfg(unix)]
    {
        unix::login_shell_which(bin)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(unix)]
mod unix {
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::time::Duration;

    pub fn fix() {
        let mut dirs: Vec<String> = Vec::new();

        // 1) Ask the login shell for its PATH (best signal — reflects the user's
        //    actual profile). Timeout-guarded so a bad shell can't hang startup.
        if let Some(path) = shell_path() {
            push_split(&mut dirs, &path);
        }

        // 2) Well-known install locations, so the common case works even if the
        //    shell probe returned nothing.
        if let Ok(home) = std::env::var("HOME") {
            for d in [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ] {
                dirs.push(d.to_string());
            }
            dirs.push(format!("{home}/.local/bin"));
            dirs.push(format!("{home}/bin"));
            dirs.push(format!("{home}/.cargo/bin"));
            // pip `--user` on macOS: ~/Library/Python/<ver>/bin — add every
            // version dir that actually has a bin/ (where `aider` lands).
            if let Ok(entries) = std::fs::read_dir(format!("{home}/Library/Python")) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        dirs.push(bin.to_string_lossy().into_owned());
                    }
                }
            }
        }

        // 3) Preserve whatever we already had, last.
        if let Ok(cur) = std::env::var("PATH") {
            push_split(&mut dirs, &cur);
        }

        // Dedupe, preserving first-seen order.
        let mut seen = HashSet::new();
        let deduped: Vec<String> = dirs.into_iter().filter(|d| seen.insert(d.clone())).collect();

        if !deduped.is_empty() {
            std::env::set_var("PATH", deduped.join(":"));
        }
    }

    fn push_split(dirs: &mut Vec<String>, value: &str) {
        for part in value.split(':') {
            if !part.is_empty() {
                dirs.push(part.to_string());
            }
        }
    }

    /// Run a one-liner in the user's login+interactive shell and capture stdout,
    /// bounded by `timeout` so a misconfigured shell can never hang us.
    fn run_shell(script: String, timeout: Duration) -> Option<String> {
        use std::process::Command;
        use std::sync::mpsc;

        let shell = std::env::var("SHELL").ok()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let out = Command::new(&shell).args(["-ilc", &script]).output();
            let _ = tx.send(out);
        });
        let out = rx.recv_timeout(timeout).ok()?.ok()?;
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Extract the text between the first two occurrences of `delim`.
    fn between<'a>(haystack: &'a str, delim: &str) -> Option<&'a str> {
        let start = haystack.find(delim)? + delim.len();
        let end = haystack[start..].find(delim)? + start;
        Some(&haystack[start..end])
    }

    fn shell_path() -> Option<String> {
        const DELIM: &str = "__AKA_PATH_DELIM__";
        let script = format!("printf '{0}%s{0}' \"$PATH\"", DELIM);
        let stdout = run_shell(script, Duration::from_secs(3))?;
        let inner = between(&stdout, DELIM)?.trim();
        (!inner.is_empty()).then(|| inner.to_string())
    }

    /// Ask the login shell to resolve a command to its absolute path via
    /// `command -v`. Returns `None` if unresolved or not an absolute path.
    pub fn login_shell_which(bin: &str) -> Option<PathBuf> {
        const DELIM: &str = "__AKA_BIN_DELIM__";
        let script = format!(
            "printf '{0}'; command -v {1} 2>/dev/null; printf '{0}'",
            DELIM,
            shell_quote(bin),
        );
        let stdout = run_shell(script, Duration::from_secs(3))?;
        let line = between(&stdout, DELIM)?
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())?;
        let p = PathBuf::from(line);
        p.is_absolute().then_some(p)
    }

    /// Single-quote a string for safe interpolation into a shell command.
    fn shell_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}
