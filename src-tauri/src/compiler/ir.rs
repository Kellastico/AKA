//! The intermediate representation — a neutral typed graph.
//!
//! Built from a spec **checked against a target descriptor**, then consumed by
//! every backend generator. Nothing here may reference any agent by name, any
//! specific contract dialect, or any implementation language: node types are
//! the opaque strings the descriptor declared, I/O contracts are
//! JSON-Schema-shaped values, and edges are success/fail only. That neutrality
//! is the agnosticism boundary — proven by compiling a second, unrelated
//! descriptor with zero changes to this module (Stage 4, check 6).

use serde::Serialize;

use super::descriptor::TargetDescriptor;
use super::spec::TaskSpec;
use super::CompileError;

#[derive(Debug, Clone, Serialize)]
pub struct IrGraph {
    pub task_type: String,
    /// The node execution starts at: the unique node with no incoming success
    /// edge (spec order breaks ties, with a warning surfaced by the compiler).
    pub entry: String,
    pub nodes: Vec<IrNode>,
    pub edges: Vec<IrEdge>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IrNode {
    pub id: String,
    /// Opaque — one of the target descriptor's declared node types.
    pub node_type: String,
    pub model: String,
    pub tools: Vec<String>,
    pub retries: u64,
    /// JSON-Schema-shaped I/O contract. MVP: string→string pass-through; the
    /// field exists so contracts can tighten without an IR shape change.
    pub io: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Success,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
pub struct IrEdge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
}

fn default_io() -> serde_json::Value {
    serde_json::json!({
        "input": {"type": "string"},
        "output": {"type": "string"}
    })
}

/// Build the IR from a parsed spec + descriptor. Validates node types against
/// the descriptor's vocabulary and rejects cycles in the success edges (fail
/// edges are retry back-edges and may point anywhere). Returns the graph plus
/// any non-fatal warnings.
pub fn build_ir(
    spec: &TaskSpec,
    desc: &TargetDescriptor,
) -> Result<(IrGraph, Vec<String>), CompileError> {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for n in &spec.nodes {
        if !desc.node_types.iter().any(|t| t == &n.node_type) {
            errors.push(format!(
                "Node {:?} has type {:?}, which target {:?} does not declare. Its vocabulary: {}.",
                n.id,
                n.node_type,
                desc.name,
                desc.node_types.join(", ")
            ));
        }
    }

    let edges: Vec<IrEdge> = spec
        .edges
        .iter()
        .map(|e| IrEdge {
            from: e.from.clone(),
            to: e.to.clone(),
            kind: if e.on.as_deref() == Some("fail") {
                EdgeKind::Fail
            } else {
                EdgeKind::Success
            },
        })
        .collect();

    if let Some(cycle_node) = find_success_cycle(&spec.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), &edges) {
        errors.push(format!(
            "The success edges form a cycle (through node {cycle_node:?}). Only \"on\": \"fail\" edges may point backwards."
        ));
    }

    // Entry: nodes with no incoming success edge, in spec order.
    let entry_candidates: Vec<&str> = spec
        .nodes
        .iter()
        .map(|n| n.id.as_str())
        .filter(|id| {
            !edges
                .iter()
                .any(|e| e.kind == EdgeKind::Success && e.to == *id)
        })
        .collect();
    let entry = match entry_candidates.as_slice() {
        [] => {
            // Only reachable when everything is in a cycle — already an error.
            spec.nodes.first().map(|n| n.id.clone()).unwrap_or_default()
        }
        [only] => (*only).to_string(),
        [first, ..] => {
            warnings.push(format!(
                "Multiple entry candidates ({}); using {first:?} (spec order).",
                entry_candidates.join(", ")
            ));
            (*first).to_string()
        }
    };

    if !errors.is_empty() {
        return Err(CompileError::new(errors.join("\n")));
    }

    let graph = IrGraph {
        task_type: spec.task_type.clone(),
        entry,
        nodes: spec
            .nodes
            .iter()
            .map(|n| IrNode {
                id: n.id.clone(),
                node_type: n.node_type.clone(),
                model: n.model.clone(),
                tools: n.tools.clone(),
                retries: n.retries,
                io: default_io(),
            })
            .collect(),
        edges,
    };
    Ok((graph, warnings))
}

/// DFS cycle check over success edges only. Returns a node on a cycle, if any.
fn find_success_cycle(ids: &[&str], edges: &[IrEdge]) -> Option<String> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark {
        White,
        Grey,
        Black,
    }
    let mut marks: Vec<Mark> = vec![Mark::White; ids.len()];
    let index = |id: &str| ids.iter().position(|x| *x == id);

    fn visit(
        i: usize,
        ids: &[&str],
        edges: &[IrEdge],
        marks: &mut [Mark],
        index: &dyn Fn(&str) -> Option<usize>,
    ) -> Option<String> {
        marks[i] = Mark::Grey;
        for e in edges {
            if e.kind == EdgeKind::Success && e.from == ids[i] {
                if let Some(j) = index(&e.to) {
                    match marks[j] {
                        Mark::Grey => return Some(ids[j].to_string()),
                        Mark::White => {
                            if let Some(c) = visit(j, ids, edges, marks, index) {
                                return Some(c);
                            }
                        }
                        Mark::Black => {}
                    }
                }
            }
        }
        marks[i] = Mark::Black;
        None
    }

    for i in 0..ids.len() {
        if marks[i] == Mark::White {
            if let Some(c) = visit(i, ids, edges, &mut marks, &index) {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::descriptor::parse_descriptor;
    use crate::compiler::spec::parse_spec;

    const DESC: &str = r#"{
        "akaTarget": 1, "name": "t", "nodeTypes": ["research", "edit_code"], "protocol": "aka"
    }"#;

    fn spec(json: &str) -> crate::compiler::spec::TaskSpec {
        parse_spec(json).unwrap()
    }

    #[test]
    fn builds_ir_and_picks_the_entry() {
        let s = spec(
            r#"{"akaSpec":1,"taskType":"t","target":"t","nodes":[
                {"id":"a","type":"research","model":"m"},
                {"id":"b","type":"edit_code","model":"m"}],
              "edges":[{"from":"a","to":"b"},{"from":"b","to":"a","on":"fail"}]}"#,
        );
        let d = parse_descriptor(DESC).unwrap();
        let (g, warnings) = build_ir(&s, &d).unwrap();
        assert_eq!(g.entry, "a");
        assert!(warnings.is_empty());
        assert_eq!(g.edges[1].kind, EdgeKind::Fail);
    }

    #[test]
    fn rejects_a_node_type_the_target_does_not_declare() {
        let s = spec(
            r#"{"akaSpec":1,"taskType":"t","target":"t","nodes":[
                {"id":"a","type":"summon_demon","model":"m"}]}"#,
        );
        let d = parse_descriptor(DESC).unwrap();
        let err = build_ir(&s, &d).unwrap_err().message;
        assert!(err.contains("summon_demon"), "{err}");
        assert!(err.contains("vocabulary"), "{err}");
    }

    #[test]
    fn rejects_success_cycles_but_allows_fail_backedges() {
        let cyclic = spec(
            r#"{"akaSpec":1,"taskType":"t","target":"t","nodes":[
                {"id":"a","type":"research","model":"m"},
                {"id":"b","type":"edit_code","model":"m"}],
              "edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]}"#,
        );
        let d = parse_descriptor(DESC).unwrap();
        assert!(build_ir(&cyclic, &d).unwrap_err().message.contains("cycle"));
    }
}
