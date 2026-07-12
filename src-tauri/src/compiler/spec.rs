//! The task/node spec — the compiler's *input* format.
//!
//! A spec is a small, hand-editable, versioned JSON document (the same shape
//! philosophy as agent recipes, `src/lib/agent-recipe.ts`): a node list with
//! per-node model binding and tool subset, plus edges. Node `type` names are
//! **opaque strings** here — the compiler core never validates them against any
//! built-in vocabulary; they are checked against the *target descriptor's*
//! declared vocabulary when the IR is built (`ir.rs`).

use serde::{Deserialize, Serialize};

use super::CompileError;

pub const SPEC_VERSION: u64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSpec {
    #[serde(rename = "akaSpec")]
    pub aka_spec: u64,
    /// Groups compiled bundles on disk (`.äkä/compiled/<task-type>/…`), so it
    /// must be a safe single path segment.
    #[serde(rename = "taskType")]
    pub task_type: String,
    /// Name of the target descriptor this spec compiles for — resolved to
    /// `<project>/.äkä/targets/<target>.json`.
    pub target: String,
    pub nodes: Vec<SpecNode>,
    #[serde(default)]
    pub edges: Vec<SpecEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecNode {
    pub id: String,
    /// Opaque to the compiler core; validated against the target descriptor.
    #[serde(rename = "type")]
    pub node_type: String,
    /// Model binding — a model id exactly as the runtime knows it (a local
    /// `.gguf` filename or a remote model id).
    pub model: String,
    /// The tool subset this node's grammar/prompt are scoped to.
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub retries: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecEdge {
    pub from: String,
    pub to: String,
    /// `None` = success edge (the normal sequence); `Some("fail")` = the
    /// retry/escalation edge taken when `from` fails.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
}

/// True when `s` is safe as a single path segment (used for `taskType`).
fn path_safe(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && s != "."
        && s != ".."
}

/// Parse + validate a spec document. Errors are friendly, aggregated strings
/// (recipe-style) — a malformed spec must fail *here*, at compile time, with a
/// message a human can act on, never reach an agent at runtime.
pub fn parse_spec(text: &str) -> Result<TaskSpec, CompileError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(CompileError::new("The task spec is empty."));
    }
    let raw: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| CompileError::new(format!("The task spec isn't valid JSON: {e}.")))?;
    let obj = raw
        .as_object()
        .ok_or_else(|| CompileError::new("A task spec must be a JSON object."))?;
    match obj.get("akaSpec") {
        None => {
            return Err(CompileError::new(
                "Missing \"akaSpec\" field — is this an ÄKÄ task spec?",
            ))
        }
        Some(v) => match v.as_u64() {
            Some(SPEC_VERSION) => {}
            Some(other) => {
                return Err(CompileError::new(format!(
                    "Unsupported spec version {other} — this compiler understands version {SPEC_VERSION}."
                )))
            }
            None => {
                return Err(CompileError::new(
                    "\"akaSpec\" must be a version number.",
                ))
            }
        },
    }

    let spec: TaskSpec = serde_json::from_value(raw)
        .map_err(|e| CompileError::new(format!("The task spec is malformed: {e}.")))?;

    let mut errors: Vec<String> = Vec::new();

    if !path_safe(&spec.task_type) {
        errors.push(format!(
            "\"taskType\" must be a single filesystem-safe segment (letters, digits, '-', '_', '.'), got {:?}.",
            spec.task_type
        ));
    }
    if spec.target.trim().is_empty() {
        errors.push("\"target\" is required — the name of the target descriptor to compile for.".into());
    }
    if spec.nodes.is_empty() {
        errors.push("A spec needs at least one node.".into());
    }

    let mut seen: Vec<&str> = Vec::new();
    for n in &spec.nodes {
        if n.id.trim().is_empty() {
            errors.push("Every node needs a non-empty \"id\".".into());
            continue;
        }
        if seen.contains(&n.id.as_str()) {
            errors.push(format!("Duplicate node id {:?}.", n.id));
        }
        seen.push(&n.id);
        if n.node_type.trim().is_empty() {
            errors.push(format!("Node {:?} needs a non-empty \"type\".", n.id));
        }
        if n.model.trim().is_empty() {
            errors.push(format!("Node {:?} needs a \"model\" binding.", n.id));
        }
        for t in &n.tools {
            if t.trim().is_empty() {
                errors.push(format!("Node {:?} lists an empty tool name.", n.id));
            }
        }
    }

    for e in &spec.edges {
        for endpoint in [&e.from, &e.to] {
            if !seen.contains(&endpoint.as_str()) {
                errors.push(format!(
                    "Edge {:?} → {:?} references unknown node {:?}.",
                    e.from, e.to, endpoint
                ));
            }
        }
        if let Some(on) = &e.on {
            if on != "fail" {
                errors.push(format!(
                    "Edge {:?} → {:?}: \"on\" must be \"fail\" (or omitted for the success edge), got {:?}.",
                    e.from, e.to, on
                ));
            }
        }
    }

    if errors.is_empty() {
        Ok(spec)
    } else {
        Err(CompileError::new(errors.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const SAMPLE: &str = r#"{
        "akaSpec": 1,
        "taskType": "bug-fix",
        "target": "enyo-anya",
        "nodes": [
            {"id": "find", "type": "research", "model": "m.gguf", "tools": ["read_file", "search"]},
            {"id": "fix", "type": "edit_code", "model": "m.gguf", "tools": ["edit_file"], "retries": 2}
        ],
        "edges": [
            {"from": "find", "to": "fix"},
            {"from": "fix", "to": "find", "on": "fail"}
        ]
    }"#;

    #[test]
    fn parses_a_valid_spec() {
        let s = parse_spec(SAMPLE).expect("valid spec");
        assert_eq!(s.task_type, "bug-fix");
        assert_eq!(s.nodes.len(), 2);
        assert_eq!(s.nodes[1].retries, 2);
        assert_eq!(s.edges[1].on.as_deref(), Some("fail"));
    }

    #[test]
    fn rejects_non_json_and_non_objects() {
        assert!(parse_spec("").is_err());
        assert!(parse_spec("not json").is_err());
        assert!(parse_spec("[1,2]").unwrap_err().message.contains("JSON object"));
    }

    #[test]
    fn rejects_missing_or_wrong_version() {
        assert!(parse_spec(r#"{"taskType":"t"}"#)
            .unwrap_err()
            .message
            .contains("akaSpec"));
        assert!(parse_spec(r#"{"akaSpec":9,"taskType":"t","target":"x","nodes":[]}"#)
            .unwrap_err()
            .message
            .contains("Unsupported spec version 9"));
    }

    #[test]
    fn aggregates_friendly_validation_errors() {
        let bad = r#"{
            "akaSpec": 1,
            "taskType": "../evil",
            "target": "enyo-anya",
            "nodes": [
                {"id": "a", "type": "research", "model": "m"},
                {"id": "a", "type": "", "model": ""}
            ],
            "edges": [{"from": "a", "to": "ghost", "on": "sometimes"}]
        }"#;
        let err = parse_spec(bad).unwrap_err().message;
        assert!(err.contains("taskType"), "{err}");
        assert!(err.contains("Duplicate node id"), "{err}");
        assert!(err.contains("unknown node \"ghost\""), "{err}");
        assert!(err.contains("\"on\" must be \"fail\""), "{err}");
    }
}
