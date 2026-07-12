//! Target descriptors — the abstraction that keeps the compiler agent-agnostic.
//!
//! A descriptor is a small versioned JSON manifest, one per consuming agent,
//! stored at `<project>/.äkä/targets/<name>.json` and supplied **as data**. It
//! declares the agent's node-type vocabulary, its protocol format, its
//! tool-schema shape, its failure-signaling style, and its prompt-assembly
//! conventions. Everything specific to a given agent (including Änyä/Enyö-Änyä)
//! lives in *its* descriptor file — never in compiler code. This mirrors how the
//! runtime stays agnostic: capabilities are advertised/declared data
//! (`AgentBlock`, `--äkä-probe`), and the host never branches on agent identity.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::CompileError;

pub const TARGET_VERSION: u64 = 1;

/// Protocol dialects the MVP's protocol generator can emit instructions for.
/// These are the wire shapes ÄKÄ's existing stream parsers already accept
/// (`src/lib/agent-parsers/`); a target picks one by name. Descriptor-defined
/// custom dialects are deferred.
pub const KNOWN_PROTOCOLS: [&str; 3] = ["aka", "jsonl", "plain"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetDescriptor {
    #[serde(rename = "akaTarget")]
    pub aka_target: u64,
    pub name: String,
    /// The agent's node-type vocabulary. This is where names like
    /// `research`/`edit_code`/`test` live — as this target's data.
    #[serde(rename = "nodeTypes")]
    pub node_types: Vec<String>,
    /// One of [`KNOWN_PROTOCOLS`].
    pub protocol: String,
    /// Shape of the tool schema the target consumes. MVP: `"aka-catalog"`
    /// (names resolved against ÄKÄ's tool pantry / the agent's own tools).
    #[serde(rename = "toolSchema", default = "default_tool_schema")]
    pub tool_schema: String,
    #[serde(default)]
    pub failure: FailureBlock,
    #[serde(default)]
    pub prompt: PromptBlock,
}

fn default_tool_schema() -> String {
    "aka-catalog".into()
}

/// How the target signals node failure (drives the DAG's retry edges and the
/// protocol artifact's `failure` section). Free-form style string — data the
/// target defines, not a compiler enum.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FailureBlock {
    #[serde(default)]
    pub style: String,
}

/// Prompt-assembly conventions: named section templates rendered in
/// `section_order`. Templates may use `{node_id}`, `{node_type}`,
/// `{task_type}`, and `{tools}` placeholders. A `BTreeMap` keeps serialization
/// deterministic, which the byte-stable prompt artifacts depend on.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PromptBlock {
    #[serde(rename = "sectionOrder", default)]
    pub section_order: Vec<String>,
    #[serde(default)]
    pub templates: BTreeMap<String, String>,
}

/// Parse + validate a descriptor document (same friendly-error contract as
/// `parse_spec`).
pub fn parse_descriptor(text: &str) -> Result<TargetDescriptor, CompileError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(CompileError::new("The target descriptor is empty."));
    }
    let raw: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| {
        CompileError::new(format!("The target descriptor isn't valid JSON: {e}."))
    })?;
    let obj = raw
        .as_object()
        .ok_or_else(|| CompileError::new("A target descriptor must be a JSON object."))?;
    match obj.get("akaTarget").and_then(|v| v.as_u64()) {
        Some(TARGET_VERSION) => {}
        Some(other) => {
            return Err(CompileError::new(format!(
                "Unsupported target descriptor version {other} — this compiler understands version {TARGET_VERSION}."
            )))
        }
        None => {
            return Err(CompileError::new(
                "Missing or invalid \"akaTarget\" version field — is this an ÄKÄ target descriptor?",
            ))
        }
    }

    let desc: TargetDescriptor = serde_json::from_value(raw)
        .map_err(|e| CompileError::new(format!("The target descriptor is malformed: {e}.")))?;

    let mut errors: Vec<String> = Vec::new();
    if desc.name.trim().is_empty() {
        errors.push("The descriptor needs a non-empty \"name\".".into());
    }
    if desc.node_types.is_empty() {
        errors.push("\"nodeTypes\" must declare at least one node type.".into());
    }
    if desc.node_types.iter().any(|t| t.trim().is_empty()) {
        errors.push("\"nodeTypes\" contains an empty name.".into());
    }
    if !KNOWN_PROTOCOLS.contains(&desc.protocol.as_str()) {
        errors.push(format!(
            "Unknown protocol {:?} — this compiler implements {:?} (descriptor-defined dialects are deferred).",
            desc.protocol, KNOWN_PROTOCOLS
        ));
    }
    for section in &desc.prompt.section_order {
        if !desc.prompt.templates.contains_key(section) {
            errors.push(format!(
                "Prompt section {section:?} is in \"sectionOrder\" but has no template."
            ));
        }
    }

    if errors.is_empty() {
        Ok(desc)
    } else {
        Err(CompileError::new(errors.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) const SAMPLE: &str = r#"{
        "akaTarget": 1,
        "name": "enyo-anya",
        "nodeTypes": ["research", "edit_code", "test", "debug", "plan", "docs", "review"],
        "protocol": "aka",
        "failure": {"style": "exit-code+aka-card"},
        "prompt": {
            "sectionOrder": ["role", "tools"],
            "templates": {
                "role": "You are the {node_type} step of a {task_type} task.",
                "tools": "You may use only these tools: {tools}."
            }
        }
    }"#;

    #[test]
    fn parses_a_valid_descriptor() {
        let d = parse_descriptor(SAMPLE).expect("valid descriptor");
        assert_eq!(d.name, "enyo-anya");
        assert_eq!(d.node_types.len(), 7);
        assert_eq!(d.protocol, "aka");
        assert_eq!(d.tool_schema, "aka-catalog");
    }

    #[test]
    fn rejects_unknown_protocol_and_missing_template() {
        let bad = r#"{
            "akaTarget": 1,
            "name": "x",
            "nodeTypes": ["a"],
            "protocol": "telepathy",
            "prompt": {"sectionOrder": ["role"], "templates": {}}
        }"#;
        let err = parse_descriptor(bad).unwrap_err().message;
        assert!(err.contains("Unknown protocol"), "{err}");
        assert!(err.contains("has no template"), "{err}");
    }

    #[test]
    fn rejects_wrong_version() {
        assert!(parse_descriptor(r#"{"akaTarget": 2, "name": "x", "nodeTypes": ["a"], "protocol": "aka"}"#)
            .unwrap_err()
            .message
            .contains("Unsupported target descriptor version 2"));
    }
}
