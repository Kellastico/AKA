//! The house layer's single enforcement chokepoint.
//!
//! Classification (folders, MCP hints) decides *where* a tool sits; **this module
//! decides whether a concrete call is allowed**, by the folder's default-deny
//! rules — regardless of what any annotation or agent claims. A tool that
//! advertised `readOnlyHint: true` is still blocked here the moment it tries to
//! write outside scope, because enforcement keys off the [`Action`], not the hint.
//!
//! ## Scope of enforcement (honest boundary)
//!
//! `check` governs the calls AKA actually mediates: the host's own
//! `apply_str_replace` / `apply_diff`, the `aka-tool` shim, the cloud-egress path,
//! and the future MCP-mediated foreign-tool dispatch (phase 2). A fully opaque
//! agent subprocess that bypasses AKA's tool layer is still covered only by the
//! sandbox (fs paths) and checkpoints — we don't claim enforcement we can't do.

use std::path::Path;

use serde::Serialize;

use super::capability::Capability;
use super::registry::ScopePolicy;
use crate::sandbox::{assert_within_sandbox, Sandbox};

/// Per-project privilege limits, distilled from `.äkä/config.json`. These can only
/// *narrow* the deny-by-default baseline (you opt specific targets in); they can
/// never widen a folder open.
#[derive(Debug, Clone, Default)]
pub struct Limits {
    /// Network destinations explicitly allowed (host, `host:port`, origin, or a
    /// URL prefix). Empty = no egress permitted.
    pub network_allowlist: Vec<String>,
    /// Process/tool names explicitly allowed to run. Empty = no exec permitted.
    pub exec_allow: Vec<String>,
    /// Whether `git`-folder actions require explicit user approval. Default true.
    pub git_requires_approval: bool,
}

/// A concrete attempted action, tagged with the folder it belongs to.
#[derive(Debug)]
pub enum Action<'a> {
    Read(&'a Path),
    Search(&'a Path),
    Write(&'a Path),
    /// Remove a file — a mutation that is **approval-gated**: deny-by-default
    /// unless the user explicitly approved it (like `git`, deletion is not a
    /// free write).
    Delete(&'a Path),
    Git,
    Network(&'a str),
    Exec(&'a str),
}

impl Action<'_> {
    pub fn folder(&self) -> Capability {
        match self {
            Action::Read(_) => Capability::FsRead,
            Action::Search(_) => Capability::Search,
            Action::Write(_) => Capability::FsWrite,
            Action::Delete(_) => Capability::FsWrite,
            Action::Git => Capability::Git,
            Action::Network(_) => Capability::Network,
            Action::Exec(_) => Capability::Exec,
        }
    }
}

/// Why a call was not allowed outright. `RequiresApproval` is a *gate*, not a
/// denial — the caller must obtain user approval (the existing permission
/// round-trip) and may then proceed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PolicyError {
    /// A filesystem path resolved outside the project root.
    OutOfScope { path: String },
    /// The folder is deny-by-default and the target wasn't opened in config.
    Denied { folder: String, target: String },
    /// The action is allowed but gated behind explicit user approval.
    RequiresApproval { folder: String },
}

/// Enforce the folder's default-deny policy for `action`. `Ok(())` = allowed.
pub fn check(action: &Action, sandbox: &Sandbox, limits: &Limits) -> Result<(), PolicyError> {
    match action {
        // Read-only, scoped folders: only the project-scope check applies.
        Action::Read(p) | Action::Search(p) | Action::Write(p) => {
            assert_within_sandbox(p, sandbox).map_err(|_| PolicyError::OutOfScope {
                path: p.display().to_string(),
            })
        }
        // Delete: must be in scope AND explicitly approved. Scope is checked first
        // (an out-of-project delete is `OutOfScope`, not merely unapproved); an
        // in-scope delete is gated behind approval so an unapproved delete is denied.
        Action::Delete(p) => {
            assert_within_sandbox(p, sandbox).map_err(|_| PolicyError::OutOfScope {
                path: p.display().to_string(),
            })?;
            Err(PolicyError::RequiresApproval {
                folder: Capability::FsWrite.as_str().to_string(),
            })
        }
        // Approval-gated. `git_requires_approval` may turn the gate off (a
        // narrowing the user opted into); it can never be widened past default.
        Action::Git => {
            if limits.git_requires_approval {
                Err(PolicyError::RequiresApproval {
                    folder: Capability::Git.as_str().to_string(),
                })
            } else {
                Ok(())
            }
        }
        // Deny by default, allowlist only.
        Action::Network(url) => match network_egress(url, &limits.network_allowlist) {
            EgressDecision::Loopback | EgressDecision::Allowlisted => Ok(()),
            EgressDecision::Denied => Err(PolicyError::Denied {
                folder: Capability::Network.as_str().to_string(),
                target: host_of(url).unwrap_or_else(|| (*url).to_string()),
            }),
        },
        // Deny by default, explicit opt-in only.
        Action::Exec(bin) => {
            if limits
                .exec_allow
                .iter()
                .any(|a| a.eq_ignore_ascii_case(bin))
            {
                Ok(())
            } else {
                Err(PolicyError::Denied {
                    folder: Capability::Exec.as_str().to_string(),
                    target: (*bin).to_string(),
                })
            }
        }
    }
}

/// Intersect a per-project `requested` policy with the deny-by-default
/// `baseline`: a project may only turn allowances *off* and gates *on* — never
/// the reverse. This is the structural guarantee behind "overrides may only
/// narrow, never widen."
pub fn narrow(baseline: ScopePolicy, requested: ScopePolicy) -> ScopePolicy {
    ScopePolicy {
        folder: baseline.folder,
        // Restrictions are monotonic: once denied/approval-gated, stays so.
        deny_by_default: baseline.deny_by_default || requested.deny_by_default,
        requires_approval: baseline.requires_approval || requested.requires_approval,
        project_scoped: baseline.project_scoped || requested.project_scoped,
        // Allowances can only be removed, never added.
        allows_write: baseline.allows_write && requested.allows_write,
        allows_egress: baseline.allows_egress && requested.allows_egress,
        allows_exec: baseline.allows_exec && requested.allows_exec,
    }
}

// ---------- network egress (Task 8: cloud = a `network` path) ----------

/// The classification of an outbound base URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressDecision {
    /// Loopback — local-first, ungated.
    Loopback,
    /// Remote but explicitly allowlisted — allowed, surfaced as a network action.
    Allowlisted,
    /// Remote and not allowlisted — denied by default.
    Denied,
}

/// Extract the host (no scheme, userinfo, port, or path) from a URL. Best-effort,
/// dependency-free — enough to classify loopback vs remote and match an allowlist.
pub fn host_of(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    // Authority ends at the first '/', '?' or '#'.
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Drop userinfo.
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    if authority.is_empty() {
        return None;
    }
    // IPv6 literal: host is inside the brackets.
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().map(|h| h.to_string());
    }
    // host[:port]
    Some(
        authority
            .split(':')
            .next()
            .unwrap_or(authority)
            .to_string(),
    )
}

/// Whether a URL points at loopback (localhost / 127.0.0.0/8 / ::1). These are the
/// local-first endpoints that are never gated.
pub fn is_loopback_url(url: &str) -> bool {
    match host_of(url) {
        Some(h) => {
            let h = h.to_ascii_lowercase();
            h == "localhost" || h == "::1" || h.starts_with("127.")
        }
        None => false,
    }
}

/// Classify an outbound base URL against the network allowlist.
pub fn network_egress(url: &str, allowlist: &[String]) -> EgressDecision {
    if is_loopback_url(url) {
        return EgressDecision::Loopback;
    }
    let host = host_of(url);
    let allowed = allowlist.iter().any(|entry| {
        let entry = entry.trim();
        if entry.is_empty() {
            return false;
        }
        // Match a full-URL/origin prefix, or an exact host (with or without port).
        url.starts_with(entry)
            || host.as_deref().is_some_and(|h| {
                entry.eq_ignore_ascii_case(h) || entry.split(':').next() == Some(h)
            })
    });
    if allowed {
        EgressDecision::Allowlisted
    } else {
        EgressDecision::Denied
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox_at(root: &Path) -> Sandbox {
        // `project_path` is a pub field — construct directly for tests.
        Sandbox {
            project_path: root.to_path_buf(),
        }
    }

    #[test]
    fn host_and_loopback_parsing() {
        assert_eq!(host_of("http://localhost:11434/v1").as_deref(), Some("localhost"));
        assert_eq!(host_of("https://api.openai.com/v1").as_deref(), Some("api.openai.com"));
        assert_eq!(host_of("http://user:pw@10.0.0.5:8080/x").as_deref(), Some("10.0.0.5"));
        assert_eq!(host_of("http://[::1]:8080/v1").as_deref(), Some("::1"));

        assert!(is_loopback_url("http://localhost:11434/v1"));
        assert!(is_loopback_url("http://127.0.0.1:8080"));
        assert!(is_loopback_url("http://[::1]:8080/v1"));
        assert!(!is_loopback_url("https://api.openai.com/v1"));
        assert!(!is_loopback_url("http://0.0.0.0:8080")); // all-interfaces ≠ loopback
    }

    #[test]
    fn egress_is_deny_by_default_for_remote() {
        // Loopback is always fine.
        assert_eq!(
            network_egress("http://localhost:11434/v1", &[]),
            EgressDecision::Loopback
        );
        // Remote with empty allowlist → denied.
        assert_eq!(
            network_egress("https://api.openai.com/v1", &[]),
            EgressDecision::Denied
        );
        // Remote, host allowlisted → allowed.
        assert_eq!(
            network_egress("https://api.openai.com/v1", &["api.openai.com".into()]),
            EgressDecision::Allowlisted
        );
        // URL-prefix allowlist entry also works.
        assert_eq!(
            network_egress(
                "https://api.anthropic.com/v1/messages",
                &["https://api.anthropic.com".into()]
            ),
            EgressDecision::Allowlisted
        );
    }

    #[test]
    fn write_outside_root_is_denied_even_for_a_readonly_claim() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let root = tmp.join("aka-policy-root");
        std::fs::create_dir_all(&root).unwrap();
        let sb = sandbox_at(&root);
        let limits = Limits::default();

        // In-scope write → allowed by scope.
        let inside = root.join("a.txt");
        assert!(check(&Action::Write(&inside), &sb, &limits).is_ok());

        // Out-of-scope write → OutOfScope, no matter what a hint might have said.
        let outside = tmp.join("escape.txt");
        assert!(matches!(
            check(&Action::Write(&outside), &sb, &limits),
            Err(PolicyError::OutOfScope { .. })
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_exec_network_are_denied_or_gated_by_default() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let sb = sandbox_at(&tmp);
        let limits = Limits {
            git_requires_approval: true,
            ..Default::default()
        };
        // git → approval gate.
        assert!(matches!(
            check(&Action::Git, &sb, &limits),
            Err(PolicyError::RequiresApproval { .. })
        ));
        // exec with empty opt-in → denied.
        assert!(matches!(
            check(&Action::Exec("rm"), &sb, &limits),
            Err(PolicyError::Denied { .. })
        ));
        // network remote with empty allowlist → denied.
        assert!(matches!(
            check(&Action::Network("https://evil.example/x"), &sb, &limits),
            Err(PolicyError::Denied { .. })
        ));
        // Opting exec in narrows the deny → allowed for that bin only.
        let limits2 = Limits {
            exec_allow: vec!["pytest".into()],
            ..Default::default()
        };
        assert!(check(&Action::Exec("pytest"), &sb, &limits2).is_ok());
        assert!(check(&Action::Exec("rm"), &sb, &limits2).is_err());
    }

    #[test]
    fn delete_is_scope_checked_then_approval_gated() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let root = tmp.join("aka-policy-delete");
        std::fs::create_dir_all(&root).unwrap();
        let sb = sandbox_at(&root);
        let limits = Limits::default();

        // An out-of-project delete is OutOfScope, not merely unapproved.
        let outside = tmp.join("victim.txt");
        assert!(matches!(
            check(&Action::Delete(&outside), &sb, &limits),
            Err(PolicyError::OutOfScope { .. })
        ));

        // An in-scope delete is approval-gated → denied unless approved.
        let inside = root.join("a.txt");
        assert!(matches!(
            check(&Action::Delete(&inside), &sb, &limits),
            Err(PolicyError::RequiresApproval { .. })
        ));
        // Delete self-classifies into the fs_write folder.
        assert_eq!(Action::Delete(&inside).folder(), Capability::FsWrite);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn narrow_never_widens() {
        let baseline = ScopePolicy::for_folder(Capability::FsRead); // no write
        // A malicious/over-eager override that tries to grant write + egress.
        let mut requested = ScopePolicy::for_folder(Capability::FsRead);
        requested.allows_write = true;
        requested.allows_egress = true;
        requested.deny_by_default = false;
        let merged = narrow(baseline, requested);
        assert!(!merged.allows_write, "narrow must not grant write");
        assert!(!merged.allows_egress, "narrow must not grant egress");
        // And it *can* tighten: a request to deny-by-default sticks.
        let tighten = {
            let mut r = ScopePolicy::for_folder(Capability::FsRead);
            r.deny_by_default = true;
            r
        };
        assert!(narrow(ScopePolicy::for_folder(Capability::FsRead), tighten).deny_by_default);
    }
}
