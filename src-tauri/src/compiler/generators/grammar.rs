//! GBNF compilation — a per-node grammar scoped to that node's tool subset.
//!
//! MVP scope (deliberately basic): the grammar constrains a tool call to a JSON
//! object `{"tool": <name>, "args": {…}}` where `<name>` may **only** be one of
//! the node's declared tools — not the full tool surface. Argument-type-precise
//! grammars are deferred. Enforcement is a *runtime capability*: llama.cpp-style
//! servers (including the built-in sidecar) accept GBNF; other endpoints simply
//! ignore the artifact. This narrows what a node can emit — it never replaces
//! `tools::policy` enforcement at call time (routing, not enforcement).

use crate::compiler::ir::IrNode;

/// Escape a tool name for use inside a GBNF double-quoted literal.
fn gbnf_literal(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Emit the GBNF grammar for one node. Deterministic: tools render in spec
/// order, no timestamps or environment data. A node with no tools gets an
/// unconstrained-JSON-object grammar (documented in the header comment).
pub fn generate(node: &IrNode) -> String {
    let mut g = String::new();
    g.push_str("# GBNF grammar compiled by ÄKÄ — scoped to this node's tool subset.\n");
    g.push_str(&format!("# node: {} ({})\n", node.id, node.node_type));

    if node.tools.is_empty() {
        g.push_str("# no tools declared for this node — tool-call shape is unconstrained JSON\n");
        g.push_str("root ::= object\n");
    } else {
        g.push_str(&format!("# tools: {}\n", node.tools.join(", ")));
        g.push_str("root ::= call\n");
        g.push_str(
            "call ::= \"{\" ws \"\\\"tool\\\"\" ws \":\" ws toolname ws \",\" ws \"\\\"args\\\"\" ws \":\" ws object ws \"}\"\n",
        );
        let alternation = node
            .tools
            .iter()
            .map(|t| format!("\"\\\"{}\\\"\"", gbnf_literal(t)))
            .collect::<Vec<_>>()
            .join(" | ");
        g.push_str(&format!("toolname ::= {alternation}\n"));
    }

    // Shared JSON building blocks.
    g.push_str(concat!(
        "object ::= \"{\" ws ( pair ( ws \",\" ws pair )* )? ws \"}\"\n",
        "pair ::= string ws \":\" ws value\n",
        "value ::= object | array | string | number | \"true\" | \"false\" | \"null\"\n",
        "array ::= \"[\" ws ( value ( ws \",\" ws value )* )? ws \"]\"\n",
        "string ::= \"\\\"\" ( [^\"\\\\] | \"\\\\\" . )* \"\\\"\"\n",
        "number ::= \"-\"? [0-9]+ (\".\" [0-9]+)?\n",
        "ws ::= [ \\t\\n]*\n",
    ));
    g
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::ir::IrNode;

    fn node(tools: &[&str]) -> IrNode {
        IrNode {
            id: "n".into(),
            node_type: "t".into(),
            model: "m".into(),
            tools: tools.iter().map(|s| s.to_string()).collect(),
            retries: 0,
            io: serde_json::json!({}),
        }
    }

    #[test]
    fn alternation_contains_exactly_the_declared_subset() {
        let g = generate(&node(&["read_file", "search"]));
        assert!(g.contains(r#"toolname ::= "\"read_file\"" | "\"search\"""#), "{g}");
        assert!(!g.contains("edit_file"), "must not leak the full tool surface");
    }

    #[test]
    fn empty_subset_degrades_to_unconstrained_object() {
        let g = generate(&node(&[]));
        assert!(g.contains("root ::= object"), "{g}");
        assert!(!g.contains("toolname"), "{g}");
    }

    #[test]
    fn output_is_deterministic() {
        let n = node(&["b_tool", "a_tool"]);
        assert_eq!(generate(&n), generate(&n));
        // Spec order is preserved — not sorted — so the grammar mirrors the
        // author's declared priority.
        let g = generate(&n);
        assert!(g.find("b_tool").unwrap() < g.find("a_tool").unwrap());
    }
}
