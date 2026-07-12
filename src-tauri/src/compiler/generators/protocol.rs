//! Protocol codegen — per-node emission instructions in the target's dialect.
//!
//! There is no runtime protocol *formatter* in ÄKÄ to reuse — the existing
//! stream parsers (`src/lib/agent-parsers/`) are consumers, and their accepted
//! grammars are the contract. This generator writes a `protocol.json` telling
//! the consuming agent exactly which wire shape to emit for this node so the
//! host's existing parsers render it with zero runtime negotiation. The dialect
//! choice is driven purely by the target descriptor's `protocol` field.

use serde_json::{json, Value};

use crate::compiler::descriptor::TargetDescriptor;
use crate::compiler::hash::canonical_json;
use crate::compiler::ir::IrNode;

/// Emission instructions per dialect. Shapes mirror what the corresponding
/// parser accepts today:
/// - `aka`: `@@aka {…}` sentinel lines (`protocol.ts`, one marker per tool call)
/// - `jsonl`: one JSON event object per stdout line
/// - `plain`: prose only — no structured emission
fn emission(protocol: &str) -> Value {
    match protocol {
        "aka" => json!({
            "kind": "sentinel-line",
            "marker": "@@aka",
            "toolCall": {
                "shape": {"tool": "read|write|run|search", "name": "string?", "path": "string?",
                           "preview": "string?", "ok": "bool?", "ms": "int?"},
                "rule": "one complete `@@aka {json}` line per finished tool call; split long-running calls with phase:start/end"
            }
        }),
        "jsonl" => json!({
            "kind": "jsonl",
            "toolCall": {
                "shape": {"type": "tool", "tool": "string", "args": "object", "ok": "bool?"},
                "rule": "one JSON object per stdout line; no prose on protocol lines"
            }
        }),
        // "plain" — descriptor validation guarantees membership in KNOWN_PROTOCOLS.
        _ => json!({ "kind": "plain-text" }),
    }
}

/// Render `protocol.json` for one node. Canonical serialization keeps the
/// artifact byte-stable (it participates in the node's content address).
pub fn generate(node: &IrNode, desc: &TargetDescriptor) -> String {
    let doc = json!({
        "akaProtocol": 1,
        "protocol": desc.protocol,
        "emission": emission(&desc.protocol),
        "failure": {"style": desc.failure.style},
        "node": {"id": node.id, "type": node.node_type},
        "io": node.io,
    });
    let mut s = canonical_json(&doc);
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::descriptor::parse_descriptor;

    fn node() -> IrNode {
        IrNode {
            id: "n".into(),
            node_type: "research".into(),
            model: "m".into(),
            tools: vec![],
            retries: 0,
            io: serde_json::json!({"input": {"type": "string"}}),
        }
    }

    #[test]
    fn dialect_is_driven_by_the_descriptor_alone() {
        let aka = parse_descriptor(
            r#"{"akaTarget":1,"name":"a","nodeTypes":["research"],"protocol":"aka"}"#,
        )
        .unwrap();
        let jsonl = parse_descriptor(
            r#"{"akaTarget":1,"name":"b","nodeTypes":["research"],"protocol":"jsonl"}"#,
        )
        .unwrap();
        let g_aka = generate(&node(), &aka);
        let g_jsonl = generate(&node(), &jsonl);
        assert!(g_aka.contains("@@aka"), "{g_aka}");
        assert!(g_jsonl.contains("\"kind\":\"jsonl\""), "{g_jsonl}");
        assert!(!g_jsonl.contains("@@aka"));
    }

    #[test]
    fn output_parses_and_is_canonical() {
        let d = parse_descriptor(
            r#"{"akaTarget":1,"name":"a","nodeTypes":["research"],"protocol":"plain"}"#,
        )
        .unwrap();
        let s = generate(&node(), &d);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["protocol"], "plain");
        assert_eq!(s, generate(&node(), &d));
    }
}
