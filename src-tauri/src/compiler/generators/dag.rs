//! DAG serialization — the sequenced, retry-aware plan the target agent walks.
//!
//! One `dag.json` per bundle. Node entries reference their artifact directories
//! **by content hash** (relative paths into the shared `.nodes/` store), which
//! is what makes regeneration incremental: rebinding one node's model changes
//! only that node's hash/artifacts, and this file — never sibling nodes'
//! artifacts. Canonically serialized so an unchanged graph is byte-identical.

use std::collections::BTreeMap;

use serde_json::json;

use crate::compiler::hash::canonical_json;
use crate::compiler::ir::{EdgeKind, IrGraph};

/// Relative path from a bundle dir (`.äkä/compiled/<task-type>/<bundle-hash>/`)
/// to a node's artifact dir in the shared store.
pub fn node_artifacts_rel(node_hash: &str) -> String {
    format!("../../.nodes/{node_hash}")
}

/// Render `dag.json`. `node_hashes` maps node id → content hash (every node is
/// guaranteed present by the compile step).
pub fn generate(graph: &IrGraph, target_name: &str, node_hashes: &BTreeMap<String, String>) -> String {
    let nodes: Vec<serde_json::Value> = graph
        .nodes
        .iter()
        .map(|n| {
            let hash = node_hashes.get(&n.id).cloned().unwrap_or_default();
            json!({
                "id": n.id,
                "type": n.node_type,
                "model": n.model,
                "tools": n.tools,
                "retries": n.retries,
                "hash": hash,
                "artifacts": node_artifacts_rel(&hash),
            })
        })
        .collect();
    let edges: Vec<serde_json::Value> = graph
        .edges
        .iter()
        .map(|e| match e.kind {
            EdgeKind::Success => json!({"from": e.from, "to": e.to}),
            EdgeKind::Fail => json!({"from": e.from, "to": e.to, "on": "fail"}),
        })
        .collect();

    let doc = json!({
        "akaDag": 1,
        "taskType": graph.task_type,
        "target": target_name,
        "entry": graph.entry,
        "nodes": nodes,
        "edges": edges,
    });
    let mut s = canonical_json(&doc);
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::descriptor::parse_descriptor;
    use crate::compiler::ir::build_ir;
    use crate::compiler::spec::parse_spec;

    #[test]
    fn serializes_entry_sequence_and_fail_edges() {
        let spec = parse_spec(
            r#"{"akaSpec":1,"taskType":"t","target":"x","nodes":[
                {"id":"a","type":"research","model":"m","tools":["read_file"]},
                {"id":"b","type":"edit_code","model":"m","retries":2}],
              "edges":[{"from":"a","to":"b"},{"from":"b","to":"a","on":"fail"}]}"#,
        )
        .unwrap();
        let desc = parse_descriptor(
            r#"{"akaTarget":1,"name":"x","nodeTypes":["research","edit_code"],"protocol":"aka"}"#,
        )
        .unwrap();
        let (graph, _) = build_ir(&spec, &desc).unwrap();
        let mut hashes = BTreeMap::new();
        hashes.insert("a".to_string(), "h_a".to_string());
        hashes.insert("b".to_string(), "h_b".to_string());

        let s = generate(&graph, "x", &hashes);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["entry"], "a");
        assert_eq!(v["nodes"][1]["retries"], 2);
        assert_eq!(v["nodes"][0]["artifacts"], "../../.nodes/h_a");
        assert_eq!(v["edges"][1]["on"], "fail");
        // Byte-stable.
        assert_eq!(s, generate(&graph, "x", &hashes));
    }
}
