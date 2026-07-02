//! Host-side execution enforcement — the "enforce from outside the agent" core.
//!
//! This module does **not** trust an agent's claim that it edited or finished. It
//! provides three pure, independently-testable primitives the command layer wires
//! in; the guarantees hold even for a foreign agent that ships no guards of its own:
//!
//!   1. [`gate_phase_advance`] — EDIT→REVIEW only on evidence of a **real on-disk
//!      change**, never on a mere claim of completion.
//!   2. [`build_witness`] — the REAL change the host observed (path + content hash
//!      + line range), not what the agent self-reported.
//!   3. [`compare_to_spine`] — a witnessed change is checked against the plan spine;
//!      an off-spine edit fails review honestly.
//!
//! Visible-card builders ([`denial_card_line`], [`witness_card_line`]) reuse the
//! existing `@@aka` tool-card shape (see `src/lib/agent-parsers/protocol.ts`), so
//! host-emitted denials and witnesses render through the identical timeline
//! pipeline as agent-authored cards — no new card system.

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::phase::Phase;

/// Why a phase transition or tool action was refused. Carried into a visible card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Denial {
    pub reason: String,
}

/// Guard the EDIT → REVIEW transition: REVIEW may only be entered once a real edit
/// has produced a real on-disk change. A claim of completion is not enough — no
/// change, no advance. Other transitions are not this contract's concern and pass
/// through untouched.
pub fn gate_phase_advance(
    current: Phase,
    target: Phase,
    produced_real_change: bool,
) -> Result<(), Denial> {
    if current == Phase::Edit && target == Phase::Review && !produced_real_change {
        return Err(Denial {
            reason: "EDIT→REVIEW blocked: no real on-disk change was recorded. An edit \
                     must fire and actually change a file before review."
                .to_string(),
        });
    }
    Ok(())
}

/// A witnessed edit — the REAL change the host observed. `hash` is the SHA-256 of
/// the post-edit content, so a claimed-but-absent change cannot masquerade as one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Witness {
    pub path: String,
    /// SHA-256 (hex) of the post-edit file content.
    pub hash: String,
    pub lines_added: u32,
    pub lines_removed: u32,
}

fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    let digest = h.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Build the witness for an edit from its real post-edit content + line counts
/// (the caller already computes the counts — `apply_str_replace_inner`, patch +/−).
/// The hash is over the real bytes on disk, so it is evidence, not a report.
pub fn build_witness(path: &str, after_content: &str, lines_added: u32, lines_removed: u32) -> Witness {
    Witness {
        path: normalize(path),
        hash: sha256_hex(after_content),
        lines_added,
        lines_removed,
    }
}

/// Normalize a path for spine comparison: trim, drop a leading `./`. Kept simple
/// and deterministic — spine entries are stored the same way.
fn normalize(path: &str) -> String {
    let p = path.trim();
    p.strip_prefix("./").unwrap_or(p).to_string()
}

/// Whether a witnessed change lands on the plan spine (the set of paths the run
/// declared it would touch). An empty spine means "no spine declared" — the caller
/// must treat that as *unverified*, never as a pass.
pub fn compare_to_spine(witness: &Witness, spine: &[String]) -> bool {
    spine.iter().any(|s| normalize(s) == witness.path)
}

// ---------- Visible `@@aka` card lines (reuse the existing tool-card shape) ----------

/// A blocked tool action, as an `@@aka` line — renders as a **failed tool card**
/// via the existing parser (`tool_start` + `tool_end{ok:false, preview}`). `tool`
/// is the card kind (`write`/`run`/`search`); `name` is the specific tool.
pub fn denial_card_line(tool: &str, name: &str, reason: &str) -> String {
    let payload = serde_json::json!({
        "tool": tool,
        "name": name,
        "ok": false,
        "preview": format!("denied: {reason}"),
    });
    format!("@@aka {payload}")
}

/// A witnessed edit, as an `@@aka` write card carrying the REAL path, line range,
/// and content hash. The `hash` field is additive — older parsers ignore it.
pub fn witness_card_line(w: &Witness) -> String {
    let payload = serde_json::json!({
        "tool": "write",
        "name": "witness",
        "path": w.path,
        "linesAdded": w.lines_added,
        "linesRemoved": w.lines_removed,
        "hash": w.hash,
        "ok": true,
    });
    format!("@@aka {payload}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::apply_str_replace_inner;

    #[test]
    fn edit_to_review_blocked_without_a_real_change() {
        // (a) The core contract: no on-disk change → no advance.
        let denied = gate_phase_advance(Phase::Edit, Phase::Review, false);
        assert!(denied.is_err());
        assert!(denied.unwrap_err().reason.contains("no real on-disk change"));
        // With a real change, the same transition is allowed.
        assert!(gate_phase_advance(Phase::Edit, Phase::Review, true).is_ok());
        // Unrelated transitions are never blocked by this guard.
        assert!(gate_phase_advance(Phase::Plan, Phase::Edit, false).is_ok());
        assert!(gate_phase_advance(Phase::Review, Phase::Commit, false).is_ok());
    }

    #[test]
    fn witness_hashes_real_content_and_matches_spine() {
        // (c) A REAL edit → witness whose hash is over the real bytes, and whose
        // path matches the declared plan spine.
        let before = "let x = 1;\nlet y = 2;\n";
        let (after, added, removed) =
            apply_str_replace_inner(before, "let y = 2;", "let y = 3;").unwrap();
        let w = build_witness("./src/a.rs", &after, added, removed);
        assert_eq!(w.path, "src/a.rs");
        assert_eq!(w.hash, sha256_hex(&after));
        assert_eq!((w.lines_added, w.lines_removed), (1, 1));

        let spine = vec!["src/a.rs".to_string(), "src/b.rs".to_string()];
        assert!(compare_to_spine(&w, &spine), "on-spine edit must match");

        // An off-spine edit does NOT match — review would fail.
        let off = build_witness("src/evil.rs", &after, added, removed);
        assert!(!compare_to_spine(&off, &spine));
        // An empty spine is "unverified", never an automatic pass.
        assert!(!compare_to_spine(&w, &[]));
    }

    #[test]
    fn denial_and_witness_cards_are_valid_aka_markers() {
        // (b)/(c) The visible cards are well-formed `@@aka` lines the parser reads.
        let d = denial_card_line("write", "delete_file", "unapproved delete of a.txt");
        assert!(d.starts_with("@@aka "));
        let json: serde_json::Value = serde_json::from_str(d.trim_start_matches("@@aka ")).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["tool"], "write");
        assert!(json["preview"].as_str().unwrap().starts_with("denied: "));

        let w = build_witness("src/a.rs", "after", 1, 1);
        let line = witness_card_line(&w);
        let json: serde_json::Value = serde_json::from_str(line.trim_start_matches("@@aka ")).unwrap();
        assert_eq!(json["tool"], "write");
        assert_eq!(json["ok"], true);
        assert_eq!(json["hash"], w.hash);
    }
}
