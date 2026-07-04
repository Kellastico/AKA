//! The centralized MessageValidator — the last gate before ANY provider request.
//!
//! Every outbound LLM call (`call_llm`, `call_llm_tools`, `call_llm_stream`,
//! `summarize_session`) runs its message array through `sanitize` immediately
//! before the request is built, so no provider — OpenAI-compatible, OpenRouter,
//! Anthropic, Cohere, Gemini, or a local runtime — ever receives a malformed
//! message ("invalid message provided at index X: must have non-empty content
//! or tool calls").
//!
//! Rules enforced:
//! - a message must have a valid role (`system|user|assistant|tool`);
//! - string content is trimmed; text parts inside array content are trimmed and
//!   dropped when empty (image parts are kept);
//! - empty `tool_calls` / `tool_results` arrays are removed, as are `tool_calls`
//!   entries with no function name;
//! - every surviving message must carry non-empty content OR tool calls OR tool
//!   results — otherwise it is removed;
//! - pairing invariants are preserved: a `tool` result must reference a
//!   surviving assistant tool call (orphans are removed), and a paired result
//!   whose content is empty is normalized to a placeholder rather than removed,
//!   so no dangling `tool_use` is ever created.
//!
//! The input is never mutated — `sanitize` returns a new array plus the list of
//! removals (logged via `log_removals`). Everything here is pure JSON-in →
//! JSON-out, so the whole rule set is unit-tested without a network.

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

/// The error returned instead of a provider request when validation removes
/// everything except the system prompt.
pub const EMPTY_CONVERSATION: &str =
    "Conversation contains no valid user or assistant messages after validation.";

const VALID_ROLES: [&str; 4] = ["system", "user", "assistant", "tool"];

/// Substituted for a paired tool result whose content was empty — removing the
/// result would orphan the assistant's `tool_use` and trade one provider error
/// for another.
const EMPTY_TOOL_RESULT: &str = "(no output)";

/// One removed message: where it sat in the original array and why it went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    pub index: usize,
    pub reason: String,
}

/// Log every removal in the `[MessageValidator]` format. Called by each
/// provider entry point right after `sanitize`.
pub fn log_removals(removals: &[Removal]) {
    for r in removals {
        eprintln!(
            "[MessageValidator] Removed message. Reason: {}. Index: {}.",
            r.reason, r.index
        );
    }
}

/// True when at least one non-system message survived — i.e. there is
/// something to actually send. Callers return `EMPTY_CONVERSATION` when false.
pub fn has_non_system(messages: &[Value]) -> bool {
    messages
        .iter()
        .any(|m| m["role"].as_str().is_some_and(|r| r != "system"))
}

/// Validate and normalize a raw (OpenAI-shaped) message array. Returns the new
/// sanitized array plus every removal; the input is untouched.
pub fn sanitize(messages: &[Value]) -> (Vec<Value>, Vec<Removal>) {
    let mut kept: Vec<Value> = Vec::with_capacity(messages.len());
    let mut removed: Vec<Removal> = Vec::new();
    // Ids of tool calls on kept assistant messages — a `tool` result must
    // reference one of these to survive. Some local runtimes omit call ids
    // entirely (both the call and its result carry ""), so those pair by
    // presence instead: `anonymous_calls` counts id-less kept calls.
    let mut open_call_ids: HashSet<String> = HashSet::new();
    let mut anonymous_calls: usize = 0;

    for (index, original) in messages.iter().enumerate() {
        let Some(obj) = original.as_object() else {
            removed.push(Removal {
                index,
                reason: "Not a message object".into(),
            });
            continue;
        };
        if obj.is_empty() {
            removed.push(Removal {
                index,
                reason: "Completely empty message object".into(),
            });
            continue;
        }
        let role = match obj.get("role").and_then(|r| r.as_str()) {
            None => {
                removed.push(Removal {
                    index,
                    reason: "Missing role".into(),
                });
                continue;
            }
            Some(r) if !VALID_ROLES.contains(&r) => {
                removed.push(Removal {
                    index,
                    reason: format!("Invalid role \"{r}\""),
                });
                continue;
            }
            Some(r) => r.to_string(),
        };

        // Normalize a clone — the caller's history is never mutated.
        let mut msg = original.clone();
        let m = msg.as_object_mut().expect("checked object above");

        let content_empty = normalize_content(m);
        let tool_calls = normalize_tool_calls(m);
        let tool_results = normalize_array_field(m, "tool_results");

        if role == "tool" {
            let call_id = m
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let paired = if call_id.is_empty() {
                anonymous_calls > 0
            } else {
                open_call_ids.contains(call_id)
            };
            if !paired {
                removed.push(Removal {
                    index,
                    reason: "Orphaned tool result (no matching tool call)".into(),
                });
                continue;
            }
            if content_empty {
                m.insert("content".into(), Value::String(EMPTY_TOOL_RESULT.into()));
            }
            kept.push(msg);
            continue;
        }

        // The keep rule: non-empty content OR tool calls OR tool results.
        if content_empty && tool_calls == 0 && tool_results == 0 {
            removed.push(Removal {
                index,
                reason: format!("Empty {role} message (no content, tool calls, or tool results)"),
            });
            continue;
        }

        if role == "assistant" && tool_calls > 0 {
            if let Some(calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
                for c in calls {
                    match c.get("id").and_then(|v| v.as_str()) {
                        Some(id) if !id.is_empty() => {
                            open_call_ids.insert(id.to_string());
                        }
                        _ => anonymous_calls += 1,
                    }
                }
            }
        }
        kept.push(msg);
    }

    (kept, removed)
}

/// Run `sanitize` over a typed message array (e.g. `llm::Message`) by
/// round-tripping through JSON, so typed and raw paths share one rule set.
pub fn sanitize_typed<T>(messages: &[T]) -> (Vec<T>, Vec<Removal>)
where
    T: Serialize + DeserializeOwned,
{
    let values: Vec<Value> = messages
        .iter()
        .filter_map(|m| serde_json::to_value(m).ok())
        .collect();
    let (kept, removed) = sanitize(&values);
    let typed = kept
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    (typed, removed)
}

/// Trim string content in place; trim text parts inside array content and drop
/// the ones that end up empty (image/other parts are kept verbatim). Returns
/// whether the content is empty after normalization (missing and null count as
/// empty).
fn normalize_content(m: &mut Map<String, Value>) -> bool {
    match m.get_mut("content") {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.len() != s.len() {
                *s = trimmed.to_string();
            }
            s.is_empty()
        }
        Some(Value::Array(parts)) => {
            parts.retain_mut(|p| {
                if p["type"].as_str() == Some("text") {
                    let trimmed = p["text"].as_str().unwrap_or("").trim().to_string();
                    if trimmed.is_empty() {
                        return false;
                    }
                    p["text"] = Value::String(trimmed);
                }
                true
            });
            parts.is_empty()
        }
        Some(Value::Null) | None => true,
        // Any other JSON type is not valid content.
        Some(_) => {
            m.insert("content".into(), Value::String(String::new()));
            true
        }
    }
}

/// Drop `tool_calls` entries with no function name, then drop the key entirely
/// when the array is empty (or was never an array). Returns the surviving count.
fn normalize_tool_calls(m: &mut Map<String, Value>) -> usize {
    let Some(v) = m.get_mut("tool_calls") else {
        return 0;
    };
    let count = match v.as_array_mut() {
        Some(calls) => {
            calls.retain(|c| {
                c["function"]["name"]
                    .as_str()
                    .is_some_and(|n| !n.trim().is_empty())
            });
            calls.len()
        }
        None => 0,
    };
    if count == 0 {
        m.remove("tool_calls");
    }
    count
}

/// Remove `key` when it holds an empty (or non-) array. Returns the surviving
/// count. Used for `tool_results`, which AKA doesn't emit itself but future
/// adapters might.
fn normalize_array_field(m: &mut Map<String, Value>, key: &str) -> usize {
    let Some(v) = m.get(key) else {
        return 0;
    };
    let count = v.as_array().map(|a| a.len()).unwrap_or(0);
    if count == 0 {
        m.remove(key);
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reasons(removed: &[Removal]) -> Vec<&str> {
        removed.iter().map(|r| r.reason.as_str()).collect()
    }

    // ---------- Valid messages are preserved ----------

    #[test]
    fn keeps_system_plus_user() {
        let input = vec![
            json!({"role":"system","content":"be brief"}),
            json!({"role":"user","content":"hi"}),
        ];
        let (kept, removed) = sanitize(&input);
        assert_eq!(kept, input);
        assert!(removed.is_empty());
        assert!(has_non_system(&kept));
    }

    #[test]
    fn keeps_system_plus_assistant() {
        let input = vec![
            json!({"role":"system","content":"be brief"}),
            json!({"role":"assistant","content":"done"}),
        ];
        let (kept, removed) = sanitize(&input);
        assert_eq!(kept.len(), 2);
        assert!(removed.is_empty());
    }

    #[test]
    fn keeps_assistant_with_tool_calls() {
        let input = vec![json!({"role":"assistant","content":"","tool_calls":[
            {"id":"t1","type":"function","function":{"name":"read_file","arguments":"{}"}}
        ]})];
        let (kept, removed) = sanitize(&input);
        assert_eq!(kept.len(), 1);
        assert!(removed.is_empty());
        assert_eq!(kept[0]["tool_calls"][0]["function"]["name"], "read_file");
    }

    #[test]
    fn keeps_tool_result_paired_to_a_call() {
        let input = vec![
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"t1","type":"function","function":{"name":"read_file","arguments":"{}"}}
            ]}),
            json!({"role":"tool","tool_call_id":"t1","content":"file body"}),
        ];
        let (kept, removed) = sanitize(&input);
        assert_eq!(kept.len(), 2);
        assert!(removed.is_empty());
    }

    // ---------- Invalid messages are removed ----------

    #[test]
    fn removes_assistant_with_empty_content() {
        let (kept, removed) = sanitize(&[json!({"role":"assistant","content":""})]);
        assert!(kept.is_empty());
        assert_eq!(removed[0].index, 0);
        assert!(removed[0].reason.contains("Empty assistant message"));
    }

    #[test]
    fn removes_assistant_with_whitespace_only_content() {
        let (kept, removed) = sanitize(&[json!({"role":"assistant","content":"     "})]);
        assert!(kept.is_empty());
        assert_eq!(removed.len(), 1);
    }

    #[test]
    fn removes_assistant_with_empty_tool_calls() {
        let (kept, removed) =
            sanitize(&[json!({"role":"assistant","content":"","tool_calls":[]})]);
        assert!(kept.is_empty());
        assert_eq!(removed.len(), 1);
    }

    #[test]
    fn removes_assistant_with_empty_tool_results() {
        let (kept, removed) =
            sanitize(&[json!({"role":"assistant","content":"","tool_results":[]})]);
        assert!(kept.is_empty());
        assert_eq!(removed.len(), 1);
    }

    #[test]
    fn removes_missing_role() {
        let (kept, removed) = sanitize(&[json!({"content":"hello"})]);
        assert!(kept.is_empty());
        assert_eq!(reasons(&removed), vec!["Missing role"]);
    }

    #[test]
    fn removes_invalid_role() {
        let (kept, removed) = sanitize(&[json!({"role":"narrator","content":"hello"})]);
        assert!(kept.is_empty());
        assert_eq!(reasons(&removed), vec!["Invalid role \"narrator\""]);
    }

    #[test]
    fn removes_completely_empty_object() {
        let (kept, removed) = sanitize(&[json!({})]);
        assert!(kept.is_empty());
        assert_eq!(reasons(&removed), vec!["Completely empty message object"]);
    }

    // ---------- Normalization ----------

    #[test]
    fn trims_content_without_mutating_the_input() {
        let input = vec![json!({"role":"user","content":"  hi  "})];
        let (kept, _) = sanitize(&input);
        assert_eq!(kept[0]["content"], "hi");
        // Rule 10: the original array is untouched.
        assert_eq!(input[0]["content"], "  hi  ");
    }

    #[test]
    fn trims_text_parts_and_keeps_images() {
        let input = vec![json!({"role":"user","content":[
            {"type":"text","text":"  what is this?  "},
            {"type":"text","text":"   "},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}
        ]})];
        let (kept, removed) = sanitize(&input);
        assert!(removed.is_empty());
        let parts = kept[0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 2); // whitespace-only text part dropped
        assert_eq!(parts[0]["text"], "what is this?");
        assert_eq!(parts[1]["type"], "image_url");
    }

    #[test]
    fn strips_empty_tool_calls_key_but_keeps_message_with_content() {
        let (kept, removed) =
            sanitize(&[json!({"role":"assistant","content":"done","tool_calls":[]})]);
        assert!(removed.is_empty());
        assert!(kept[0].get("tool_calls").is_none());
        assert_eq!(kept[0]["content"], "done");
    }

    #[test]
    fn drops_malformed_tool_call_entries() {
        let (kept, removed) = sanitize(&[json!({"role":"assistant","content":"","tool_calls":[
            {"id":"bad","type":"function","function":{"name":""}},
        ]})]);
        // The only entry had no name → array emptied → message has no payload.
        assert!(kept.is_empty());
        assert_eq!(removed.len(), 1);
    }

    // ---------- Pairing invariants ----------

    #[test]
    fn removes_orphaned_tool_result() {
        let (kept, removed) =
            sanitize(&[json!({"role":"tool","tool_call_id":"ghost","content":"out"})]);
        assert!(kept.is_empty());
        assert!(removed[0].reason.contains("Orphaned tool result"));
    }

    #[test]
    fn cascades_orphan_removal_when_the_assistant_call_was_removed() {
        let input = vec![
            // Whitespace content + empty tool_calls → removed …
            json!({"role":"assistant","content":"  ","tool_calls":[]}),
            // … so its "result" is an orphan and goes too.
            json!({"role":"tool","tool_call_id":"t1","content":"out"}),
        ];
        let (kept, removed) = sanitize(&input);
        assert!(kept.is_empty());
        assert_eq!(removed.len(), 2);
    }

    #[test]
    fn idless_tool_calls_pair_by_presence() {
        // Some local runtimes omit call ids — the call and its result both
        // carry "". They must still pair, or we'd create a dangling tool_use.
        let input = vec![
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"","type":"function","function":{"name":"run","arguments":"{}"}}
            ]}),
            json!({"role":"tool","tool_call_id":"","content":"out"}),
        ];
        let (kept, removed) = sanitize(&input);
        assert_eq!(kept.len(), 2);
        assert!(removed.is_empty());
    }

    #[test]
    fn paired_tool_result_with_empty_content_is_normalized_not_removed() {
        let input = vec![
            json!({"role":"assistant","content":"","tool_calls":[
                {"id":"t1","type":"function","function":{"name":"run","arguments":"{}"}}
            ]}),
            json!({"role":"tool","tool_call_id":"t1","content":"   "}),
        ];
        let (kept, removed) = sanitize(&input);
        // Removing the result would leave a dangling tool_use → keep + placeholder.
        assert!(removed.is_empty());
        assert_eq!(kept[1]["content"], EMPTY_TOOL_RESULT);
    }

    // ---------- Sendability ----------

    #[test]
    fn only_system_left_is_not_sendable() {
        let input = vec![
            json!({"role":"system","content":"be brief"}),
            json!({"role":"assistant","content":""}),
        ];
        let (kept, _) = sanitize(&input);
        assert_eq!(kept.len(), 1);
        assert!(!has_non_system(&kept));
    }

    #[test]
    fn sanitize_typed_round_trips() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Msg {
            role: String,
            content: String,
        }
        let input = vec![
            Msg { role: "user".into(), content: "  hi  ".into() },
            Msg { role: "assistant".into(), content: "".into() },
        ];
        let (kept, removed) = sanitize_typed(&input);
        assert_eq!(kept, vec![Msg { role: "user".into(), content: "hi".into() }]);
        assert_eq!(removed.len(), 1);
        // Input untouched (rule 10).
        assert_eq!(input[0].content, "  hi  ");
    }
}
