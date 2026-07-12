//! Prompt assembly — a **byte-stable** per-node prompt prefix.
//!
//! The whole point of compiling prompts ahead of time is llama.cpp-style prefix
//! caching: an unchanged spec must produce the identical byte sequence every
//! time. So: sections render in the descriptor's declared order, templates come
//! from a BTreeMap (deterministic), tools render in spec order, line endings
//! are normalized to LF, and nothing time- or environment-dependent is ever
//! interpolated. The runtime task text is appended *after* this prefix by the
//! consuming agent (it arrives separately via `AKA_TASK`), so the prefix stays
//! cache-hot across different tasks of the same shape.

use crate::compiler::descriptor::TargetDescriptor;
use crate::compiler::ir::IrNode;

/// Render the prompt prefix for one node per the target's conventions.
/// Placeholders: `{node_id}`, `{node_type}`, `{task_type}`, `{tools}`.
/// Sections listed without a template are skipped (descriptor validation
/// already flags them); unknown placeholders are left intact, mirroring the
/// Task Envelope's tolerance.
pub fn generate(node: &IrNode, task_type: &str, desc: &TargetDescriptor) -> String {
    let tools = node.tools.join(", ");
    let mut sections: Vec<String> = Vec::new();
    for name in &desc.prompt.section_order {
        let Some(template) = desc.prompt.templates.get(name) else {
            continue;
        };
        let rendered = template
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace("{node_id}", &node.id)
            .replace("{node_type}", &node.node_type)
            .replace("{task_type}", task_type)
            .replace("{tools}", &tools);
        let trimmed = rendered.trim();
        if !trimmed.is_empty() {
            sections.push(trimmed.to_string());
        }
    }
    let mut out = sections.join("\n\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::descriptor::parse_descriptor;

    fn node(tools: &[&str]) -> IrNode {
        IrNode {
            id: "fix".into(),
            node_type: "edit_code".into(),
            model: "m.gguf".into(),
            tools: tools.iter().map(|s| s.to_string()).collect(),
            retries: 0,
            io: serde_json::json!({}),
        }
    }

    #[test]
    fn renders_sections_in_order_with_placeholders() {
        let d = parse_descriptor(
            r#"{"akaTarget":1,"name":"t","nodeTypes":["edit_code"],"protocol":"aka",
                "prompt":{"sectionOrder":["role","tools"],
                          "templates":{"role":"You are the {node_type} step of {task_type}.",
                                       "tools":"Tools: {tools}."}}}"#,
        )
        .unwrap();
        let p = generate(&node(&["read_file", "edit_file"]), "bug-fix", &d);
        assert_eq!(
            p,
            "You are the edit_code step of bug-fix.\n\nTools: read_file, edit_file.\n"
        );
    }

    #[test]
    fn output_is_byte_stable_across_calls() {
        let d = parse_descriptor(
            r#"{"akaTarget":1,"name":"t","nodeTypes":["edit_code"],"protocol":"aka",
                "prompt":{"sectionOrder":["a"],"templates":{"a":"line one\r\nline two"}}}"#,
        )
        .unwrap();
        let n = node(&["x"]);
        let first = generate(&n, "t", &d);
        assert_eq!(first, generate(&n, "t", &d));
        assert!(!first.contains('\r'), "line endings must be LF-only");
    }
}
