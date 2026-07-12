//! Content addressing for compiled artifacts.
//!
//! Hashes are computed over a **canonical** JSON form (recursively sorted keys,
//! compact separators, no insignificant whitespace) so that formatting-only
//! edits to a spec or descriptor never force a recompile, while any semantic
//! change always does. The bundle hash covers spec + descriptor; the node hash
//! covers one node's spec fragment + the descriptor (every generator consumes
//! the descriptor, so a descriptor change must regenerate every node).

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Serialize a JSON value canonically: object keys sorted, compact output.
/// This is the byte form every hash is computed over.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                // Keys are serialized through serde_json for correct escaping.
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        // Scalars already have a single serialization.
        other => out.push_str(&other.to_string()),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Hash a sequence of JSON values as one identity. Parts are canonicalized and
/// joined with a NUL separator so `["ab","c"]` and `["a","bc"]` can't collide.
pub fn hash_values(parts: &[&Value]) -> String {
    let mut bytes: Vec<u8> = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            bytes.push(0);
        }
        bytes.extend_from_slice(canonical_json(p).as_bytes());
    }
    sha256_hex(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_form_sorts_keys_recursively() {
        let a = json!({"b": 1, "a": {"z": true, "y": [1, {"k": "v", "j": 2}]}});
        assert_eq!(
            canonical_json(&a),
            r#"{"a":{"y":[1,{"j":2,"k":"v"}],"z":true},"b":1}"#
        );
    }

    #[test]
    fn formatting_only_differences_hash_identically() {
        let pretty: Value =
            serde_json::from_str("{\n  \"a\": 1,\n  \"b\": [1, 2]\n}").unwrap();
        let compact: Value = serde_json::from_str(r#"{"b":[1,2],"a":1}"#).unwrap();
        assert_eq!(hash_values(&[&pretty]), hash_values(&[&compact]));
    }

    #[test]
    fn semantic_change_changes_the_hash() {
        let a = json!({"model": "m1"});
        let b = json!({"model": "m2"});
        assert_ne!(hash_values(&[&a]), hash_values(&[&b]));
    }

    #[test]
    fn part_boundaries_cannot_collide() {
        let ab = json!("ab");
        let c = json!("c");
        let a = json!("a");
        let bc = json!("bc");
        assert_ne!(hash_values(&[&ab, &c]), hash_values(&[&a, &bc]));
    }
}
