//! ÄKÄ agent compiler — turns a declarative task/node spec into a runtime
//! artifact bundle: per-node protocol instructions, a GBNF grammar scoped to
//! the node's tool subset, a byte-stable prompt prefix, and a serialized DAG.
//!
//! **Agnostic by construction.** The core (spec → IR → generators) carries zero
//! agent-specific assumptions: node types are opaque strings validated against
//! a *target descriptor* supplied as data (`.äkä/targets/<name>.json`), and
//! every generator is driven by that descriptor. Änyä/Enyö-Änyä are the first
//! target, expressed entirely as one descriptor file — never as core logic.
//!
//! **Build output, not agent state.** Artifacts are content-addressed under
//! `.äkä/compiled/`: node artifacts in a shared store keyed by node hash,
//! bundles keyed by a hash over spec + descriptor. An unchanged spec is a cache
//! hit (nothing rewritten — the prefix-cache invalidation signal); a changed
//! node regenerates only itself.
//!
//! **Routing, not enforcement.** Per-node tool subsets narrow what a node is
//! told about and may emit; `tools::policy` still enforces every call at
//! runtime, unchanged. Nothing here touches the authorization surface.

pub mod descriptor;
pub mod generators;
pub mod hash;
pub mod ir;
pub mod spec;

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use descriptor::{parse_descriptor, TargetDescriptor};
use ir::build_ir;
use spec::{parse_spec, TaskSpec};

/// A compile-time failure with a human-actionable message (possibly several,
/// newline-joined). The whole point of the compiler's Stage-4 contract: a bad
/// spec fails *here*, clearly, instead of reaching an agent at runtime.
#[derive(Debug, Clone, Serialize)]
pub struct CompileError {
    pub message: String,
}

impl CompileError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CompileError {}

/// What happened to one node during a compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
    /// Artifacts already existed under this content hash — nothing regenerated.
    Cached,
    /// Artifacts were (re)generated this compile.
    Generated,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeOutcome {
    pub id: String,
    pub hash: String,
    pub status: NodeStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileOutcome {
    pub bundle_hash: String,
    /// Absolute path to the bundle dir (contains `manifest.json` + `dag.json`).
    pub bundle_dir: String,
    /// Absolute path to `manifest.json` — the value handed to a consuming
    /// agent via `AKA_COMPILED_MANIFEST`.
    pub manifest_path: String,
    /// True when the identical spec+descriptor was already compiled — nothing
    /// was written. Doubles as the prefix-cache stability signal.
    pub cache_hit: bool,
    pub nodes: Vec<NodeOutcome>,
    pub warnings: Vec<String>,
    /// Superseded bundles + orphaned node artifacts removed by this compile's
    /// retention pass (0 on a cache hit — nothing changed, nothing pruned).
    pub pruned: usize,
}

/// Project-relative roots. `.äkä` matches the existing project dot-dir
/// (config.json, TOOLS.md) — compiled output is build state alongside them.
fn aka_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".äkä")
}
pub fn targets_dir(project_dir: &Path) -> PathBuf {
    aka_dir(project_dir).join("targets")
}
fn compiled_dir(project_dir: &Path) -> PathBuf {
    aka_dir(project_dir).join("compiled")
}
fn nodes_store(project_dir: &Path) -> PathBuf {
    compiled_dir(project_dir).join(".nodes")
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> CompileError {
    CompileError::new(format!("{what} {}: {e}", path.display()))
}

/// Load and parse the target descriptor a spec names.
fn load_descriptor(project_dir: &Path, target: &str) -> Result<TargetDescriptor, CompileError> {
    if !spec_target_name_safe(target) {
        return Err(CompileError::new(format!(
            "\"target\" must be a plain descriptor name (letters, digits, '-', '_', '.'), got {target:?}."
        )));
    }
    let path = targets_dir(project_dir).join(format!("{target}.json"));
    let text = fs::read_to_string(&path).map_err(|e| {
        CompileError::new(format!(
            "Target descriptor not found: {} ({e}). Create it under .äkä/targets/ — one JSON manifest per consuming agent.",
            path.display()
        ))
    })?;
    parse_descriptor(&text)
}

fn spec_target_name_safe(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && s != "."
        && s != ".."
}

/// One model the host knows about, with a content fingerprint when the model
/// is a local file. The fingerprint (size + mtime today) participates in the
/// node/bundle hashes, so swapping a model file under the same name is a real
/// invalidation, not a silent stale-cache hit. Empty = identity unknown.
#[derive(Debug, Clone, Default)]
pub struct ModelInfo {
    pub id: String,
    pub fingerprint: String,
}

/// Everything the caller can tell the compiler about resolvable models.
/// `None` catalog = caller can't provide one (skip validation entirely).
#[derive(Debug, Clone, Default)]
pub struct ModelCatalog {
    /// Local `.gguf` files in the models folder, with fingerprints.
    pub local: Vec<ModelInfo>,
    /// Model ids the configured runtime reports serving. `None` = the runtime
    /// wasn't queried or didn't answer — bindings degrade to a warning, never
    /// a hard failure on a flaky network.
    pub remote: Option<Vec<String>>,
}

/// Model-binding checks. Local `.gguf` bindings are validated against the
/// models folder (error when absent); non-local ids are validated against the
/// runtime's reported list when available (error only on a *definitive*
/// absence), else warned as unverifiable. Returns node-id → fingerprint for
/// hashing ("" when unknown).
fn check_models(
    spec: &TaskSpec,
    catalog: Option<&ModelCatalog>,
    warnings: &mut Vec<String>,
) -> Result<BTreeMap<String, String>, CompileError> {
    let mut errors: Vec<String> = Vec::new();
    let mut fingerprints: BTreeMap<String, String> = BTreeMap::new();
    for n in &spec.nodes {
        let mut fp = String::new();
        if n.model.ends_with(".gguf") {
            if let Some(cat) = catalog {
                match cat.local.iter().find(|m| m.id == n.model) {
                    Some(m) => fp = m.fingerprint.clone(),
                    None => errors.push(format!(
                        "Node {:?} binds model {:?}, which is not in the local models folder.",
                        n.id, n.model
                    )),
                }
            }
        } else {
            match catalog.and_then(|c| c.remote.as_ref()) {
                Some(remote) if !remote.iter().any(|m| m == &n.model) => {
                    errors.push(format!(
                        "Node {:?} binds model {:?}, which the configured runtime does not serve.",
                        n.id, n.model
                    ));
                }
                Some(_) => {} // verified present on the live runtime
                None => warnings.push(format!(
                    "Node {:?} binds non-local model {:?} — existence can't be verified at compile time.",
                    n.id, n.model
                )),
            }
        }
        fingerprints.insert(n.id.clone(), fp);
    }
    if errors.is_empty() {
        Ok(fingerprints)
    } else {
        Err(CompileError::new(errors.join("\n")))
    }
}

/// Write `content` at `dir/name` atomically (temp file + rename), matching the
/// house pattern (`save_config`).
fn write_atomic(dir: &Path, name: &str, content: &str) -> Result<(), CompileError> {
    let tmp = dir.join(format!("{name}.tmp"));
    let dst = dir.join(name);
    fs::write(&tmp, content).map_err(|e| io_err("write", &tmp, e))?;
    fs::rename(&tmp, &dst).map_err(|e| io_err("rename", &dst, e))?;
    Ok(())
}

const NODE_FILES: [&str; 3] = ["prompt.txt", "tools.gbnf", "protocol.json"];

/// Compile a spec (as text) against its target descriptor into the project's
/// artifact store. Pure std::fs — callers on the async runtime wrap this in
/// `spawn_blocking`.
pub fn compile(
    project_dir: &Path,
    spec_text: &str,
    catalog: Option<&ModelCatalog>,
) -> Result<CompileOutcome, CompileError> {
    let spec = parse_spec(spec_text)?;
    let desc = load_descriptor(project_dir, &spec.target)?;

    let mut warnings: Vec<String> = Vec::new();
    if desc.name != spec.target {
        warnings.push(format!(
            "Descriptor file {:?} declares name {:?} — using the file's contents anyway.",
            spec.target, desc.name
        ));
    }
    let fingerprints = check_models(&spec, catalog, &mut warnings)?;

    let (graph, ir_warnings) = build_ir(&spec, &desc)?;
    warnings.extend(ir_warnings);

    // Content addressing: canonical values of the *parsed* spec/descriptor
    // (formatting-only edits never invalidate) plus the model fingerprints
    // (swapping a model file under an unchanged name always invalidates).
    let spec_value = serde_json::to_value(&spec)
        .map_err(|e| CompileError::new(format!("serialize spec: {e}")))?;
    let desc_value = serde_json::to_value(&desc)
        .map_err(|e| CompileError::new(format!("serialize descriptor: {e}")))?;
    let fp_value = serde_json::to_value(&fingerprints)
        .map_err(|e| CompileError::new(format!("serialize fingerprints: {e}")))?;
    let bundle_hash = hash::hash_values(&[&spec_value, &desc_value, &fp_value]);

    let mut node_hashes: BTreeMap<String, String> = BTreeMap::new();
    for n in &spec.nodes {
        let node_value = serde_json::to_value(n)
            .map_err(|e| CompileError::new(format!("serialize node {}: {e}", n.id)))?;
        let node_fp = serde_json::Value::String(
            fingerprints.get(&n.id).cloned().unwrap_or_default(),
        );
        node_hashes.insert(
            n.id.clone(),
            hash::hash_values(&[&node_value, &desc_value, &node_fp]),
        );
    }

    let bundle_dir = compiled_dir(project_dir)
        .join(&spec.task_type)
        .join(&bundle_hash);
    let manifest_path = bundle_dir.join("manifest.json");

    // Cache hit: this exact spec+descriptor was already compiled. Report every
    // node as cached and write nothing — byte stability is the contract.
    if manifest_path.exists() {
        return Ok(CompileOutcome {
            bundle_hash,
            bundle_dir: bundle_dir.to_string_lossy().into_owned(),
            manifest_path: manifest_path.to_string_lossy().into_owned(),
            cache_hit: true,
            nodes: graph
                .nodes
                .iter()
                .map(|n| NodeOutcome {
                    id: n.id.clone(),
                    hash: node_hashes[&n.id].clone(),
                    status: NodeStatus::Cached,
                })
                .collect(),
            warnings,
            pruned: 0,
        });
    }

    // Generate (or reuse) each node's artifacts in the shared content store.
    let store = nodes_store(project_dir);
    let mut outcomes: Vec<NodeOutcome> = Vec::new();
    for n in &graph.nodes {
        let h = &node_hashes[&n.id];
        let node_dir = store.join(h);
        let complete = NODE_FILES.iter().all(|f| node_dir.join(f).exists());
        if complete {
            outcomes.push(NodeOutcome { id: n.id.clone(), hash: h.clone(), status: NodeStatus::Cached });
            continue;
        }
        fs::create_dir_all(&node_dir).map_err(|e| io_err("mkdir", &node_dir, e))?;
        write_atomic(&node_dir, "prompt.txt", &generators::prompt::generate(n, &graph.task_type, &desc))?;
        write_atomic(&node_dir, "tools.gbnf", &generators::grammar::generate(n))?;
        write_atomic(&node_dir, "protocol.json", &generators::protocol::generate(n, &desc))?;
        outcomes.push(NodeOutcome { id: n.id.clone(), hash: h.clone(), status: NodeStatus::Generated });
    }

    // Bundle: dag.json + manifest.json. The manifest is what an agent receives
    // (via AKA_COMPILED_MANIFEST) — everything else is reachable from it.
    fs::create_dir_all(&bundle_dir).map_err(|e| io_err("mkdir", &bundle_dir, e))?;
    write_atomic(&bundle_dir, "dag.json", &generators::dag::generate(&graph, &desc.name, &node_hashes))?;

    let manifest_nodes: BTreeMap<&String, serde_json::Value> = node_hashes
        .iter()
        .map(|(id, h)| {
            (id, serde_json::json!({"hash": h, "dir": generators::dag::node_artifacts_rel(h)}))
        })
        .collect();
    let manifest_doc = serde_json::json!({
        "akaCompiled": 1,
        "bundleHash": bundle_hash,
        "taskType": spec.task_type,
        "target": spec.target,
        "dag": "dag.json",
        "nodes": manifest_nodes,
    });
    let mut manifest_text = hash::canonical_json(&manifest_doc);
    manifest_text.push('\n');
    write_atomic(&bundle_dir, "manifest.json", &manifest_text)?;

    // Retention: compiled artifacts are build output, not history. Keep only
    // the bundle just written for this task type, then drop node artifacts no
    // remaining manifest references. Runs strictly AFTER the new bundle is on
    // disk, so shared nodes were already reused and stay referenced.
    let pruned = prune_superseded(project_dir, &spec.task_type, &bundle_hash);

    Ok(CompileOutcome {
        bundle_hash,
        bundle_dir: bundle_dir.to_string_lossy().into_owned(),
        manifest_path: manifest_path.to_string_lossy().into_owned(),
        cache_hit: false,
        nodes: outcomes,
        warnings,
        pruned,
    })
}

/// Retention pass: delete superseded bundle dirs for `task_type` (everything
/// but `keep_hash`), then garbage-collect `.nodes/` entries that no surviving
/// manifest (across ALL task types) references. Best-effort — an unreadable
/// entry is skipped, never an error; returns how many directories were removed.
fn prune_superseded(project_dir: &Path, task_type: &str, keep_hash: &str) -> usize {
    let mut removed = 0usize;

    let type_dir = compiled_dir(project_dir).join(task_type);
    if let Ok(entries) = fs::read_dir(&type_dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy() != keep_hash
                && fs::remove_dir_all(e.path()).is_ok()
            {
                removed += 1;
            }
        }
    }

    // Hashes still referenced by any surviving bundle manifest.
    let mut referenced: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if let Ok(task_dirs) = fs::read_dir(compiled_dir(project_dir)) {
        for td in task_dirs.flatten() {
            if td.file_name().to_string_lossy().starts_with('.') {
                continue; // the .nodes store itself
            }
            let Ok(bundles) = fs::read_dir(td.path()) else { continue };
            for b in bundles.flatten() {
                let Ok(text) = fs::read_to_string(b.path().join("manifest.json")) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if let Some(nodes) = v.get("nodes").and_then(|n| n.as_object()) {
                    for meta in nodes.values() {
                        if let Some(h) = meta.get("hash").and_then(|h| h.as_str()) {
                            referenced.insert(h.to_string());
                        }
                    }
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(nodes_store(project_dir)) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !referenced.contains(&name) && fs::remove_dir_all(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Fresh scratch project dir per test (std-only; no tempfile dependency).
    fn scratch(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "aka-compiler-test-{}-{tag}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const DESC: &str = r#"{
        "akaTarget": 1,
        "name": "enyo-anya",
        "nodeTypes": ["research", "debug", "edit_code", "test", "git"],
        "protocol": "aka",
        "failure": {"style": "exit-code+aka-card"},
        "prompt": {
            "sectionOrder": ["role", "tools"],
            "templates": {
                "role": "You are the {node_type} step of a {task_type} task.",
                "tools": "Use only: {tools}."
            }
        }
    }"#;

    fn spec_json(edit_model: &str) -> String {
        format!(
            r#"{{
            "akaSpec": 1,
            "taskType": "bug-fix",
            "target": "enyo-anya",
            "nodes": [
                {{"id": "find",  "type": "research",  "model": "m.gguf", "tools": ["read_file", "search"]}},
                {{"id": "why",   "type": "debug",     "model": "m.gguf", "tools": ["read_file"]}},
                {{"id": "fix",   "type": "edit_code", "model": "{edit_model}", "tools": ["read_file", "edit_file"], "retries": 2}},
                {{"id": "check", "type": "test",      "model": "m.gguf", "tools": ["run_tests"]}},
                {{"id": "ship",  "type": "git",       "model": "m.gguf", "tools": ["git_commit"]}}
            ],
            "edges": [
                {{"from": "find", "to": "why"}},
                {{"from": "why", "to": "fix"}},
                {{"from": "fix", "to": "check"}},
                {{"from": "check", "to": "ship"}},
                {{"from": "check", "to": "fix", "on": "fail"}}
            ]
        }}"#
        )
    }

    fn install_descriptor(project: &Path, name: &str, text: &str) {
        let dir = targets_dir(project);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name}.json")), text).unwrap();
    }

    #[test]
    fn full_bundle_then_cache_hit_then_partial_regen() {
        let project = scratch("lifecycle");
        install_descriptor(&project, "enyo-anya", DESC);

        // 1. First compile: everything generated.
        let first = compile(&project, &spec_json("m.gguf"), None).unwrap();
        assert!(!first.cache_hit);
        assert_eq!(first.nodes.len(), 5);
        assert!(first.nodes.iter().all(|n| n.status == NodeStatus::Generated));
        assert!(Path::new(&first.manifest_path).exists());
        // The bundle's dag + every node's three artifacts exist.
        let dag: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(Path::new(&first.bundle_dir).join("dag.json")).unwrap()).unwrap();
        assert_eq!(dag["entry"], "find");
        for n in &first.nodes {
            let dir = nodes_store(&project).join(&n.hash);
            for f in NODE_FILES {
                assert!(dir.join(f).exists(), "missing {f} for node {}", n.id);
            }
        }

        // 2. Same spec again: cache hit, nothing regenerated.
        let second = compile(&project, &spec_json("m.gguf"), None).unwrap();
        assert!(second.cache_hit);
        assert_eq!(second.bundle_hash, first.bundle_hash);
        assert!(second.nodes.iter().all(|n| n.status == NodeStatus::Cached));

        // 3. Rebind one node's model: new bundle hash, ONLY that node regenerates.
        let third = compile(&project, &spec_json("other.gguf"), None).unwrap();
        assert!(!third.cache_hit);
        assert_ne!(third.bundle_hash, first.bundle_hash);
        for n in &third.nodes {
            if n.id == "fix" {
                assert_eq!(n.status, NodeStatus::Generated, "rebound node must regenerate");
                assert_ne!(n.hash, first.nodes.iter().find(|f| f.id == "fix").unwrap().hash);
            } else {
                assert_eq!(n.status, NodeStatus::Cached, "untouched node {} must not regenerate", n.id);
            }
        }
    }

    #[test]
    fn formatting_only_spec_changes_still_cache_hit() {
        let project = scratch("formatting");
        install_descriptor(&project, "enyo-anya", DESC);
        let first = compile(&project, &spec_json("m.gguf"), None).unwrap();
        // Reserialize the same document with different formatting/key order.
        let v: serde_json::Value = serde_json::from_str(&spec_json("m.gguf")).unwrap();
        let pretty = serde_json::to_string_pretty(&v).unwrap();
        let second = compile(&project, &pretty, None).unwrap();
        assert!(second.cache_hit);
        assert_eq!(second.bundle_hash, first.bundle_hash);
    }

    #[test]
    fn descriptor_change_invalidates_every_node() {
        let project = scratch("desc-change");
        install_descriptor(&project, "enyo-anya", DESC);
        let first = compile(&project, &spec_json("m.gguf"), None).unwrap();
        // Change a prompt template — every node's prompt derives from it.
        install_descriptor(&project, "enyo-anya", &DESC.replace("Use only", "You may use"));
        let second = compile(&project, &spec_json("m.gguf"), None).unwrap();
        assert!(!second.cache_hit);
        assert_ne!(second.bundle_hash, first.bundle_hash);
        assert!(second.nodes.iter().all(|n| n.status == NodeStatus::Generated));
    }

    fn catalog(local: &[(&str, &str)], remote: Option<&[&str]>) -> ModelCatalog {
        ModelCatalog {
            local: local
                .iter()
                .map(|(id, fp)| ModelInfo { id: id.to_string(), fingerprint: fp.to_string() })
                .collect(),
            remote: remote.map(|r| r.iter().map(|s| s.to_string()).collect()),
        }
    }

    #[test]
    fn unknown_local_model_fails_at_compile_time() {
        let project = scratch("models");
        install_descriptor(&project, "enyo-anya", DESC);
        let known = catalog(&[("m.gguf", "sz1-mt1")], None);
        assert!(compile(&project, &spec_json("m.gguf"), Some(&known)).is_ok());
        let err = compile(&project, &spec_json("ghost.gguf"), Some(&known)).unwrap_err();
        assert!(err.message.contains("ghost.gguf"), "{err}");
        assert!(err.message.contains("not in the local models folder"), "{err}");
    }

    #[test]
    fn model_fingerprint_change_invalidates_only_that_binding() {
        let project = scratch("fingerprint");
        install_descriptor(&project, "enyo-anya", DESC);
        let v1 = catalog(&[("m.gguf", "sz100-mt1")], None);
        let v2 = catalog(&[("m.gguf", "sz100-mt2")], None); // same name, new bytes
        let first = compile(&project, &spec_json("m.gguf"), Some(&v1)).unwrap();
        let second = compile(&project, &spec_json("m.gguf"), Some(&v2)).unwrap();
        // Same spec text, but the model file changed → full recompile, and every
        // node rebinds (they all use m.gguf here).
        assert!(!second.cache_hit);
        assert_ne!(second.bundle_hash, first.bundle_hash);
        assert!(second.nodes.iter().all(|n| n.status == NodeStatus::Generated));
        // And an identical fingerprint stays a cache hit.
        let third = compile(&project, &spec_json("m.gguf"), Some(&v2)).unwrap();
        assert!(third.cache_hit);
    }

    #[test]
    fn runtime_served_models_validate_definitively() {
        let project = scratch("remote");
        install_descriptor(&project, "enyo-anya", DESC);
        // The spec swaps only the `fix` node's model; the other nodes keep the
        // local m.gguf binding, so the catalog carries both surfaces.
        // Verified present: compiles without the "can't be verified" warning.
        let served = catalog(&[("m.gguf", "x")], Some(&["qwen2.5-coder:7b"]));
        let ok = compile(&project, &spec_json("qwen2.5-coder:7b"), Some(&served)).unwrap();
        assert!(ok.warnings.iter().all(|w| !w.contains("can't be verified")), "{:?}", ok.warnings);
        // Definitively absent: hard compile error.
        let err = compile(&project, &spec_json("missing:1b"), Some(&served)).unwrap_err();
        assert!(err.message.contains("does not serve"), "{err}");
        // Runtime not queried: degrades to the warning, never an error.
        let unqueried = catalog(&[("m.gguf", "x")], None);
        let warned = compile(&project, &spec_json("offline:1b"), Some(&unqueried)).unwrap();
        assert!(warned.warnings.iter().any(|w| w.contains("can't be verified")));
    }

    #[test]
    fn retention_prunes_superseded_bundles_and_orphan_nodes() {
        let project = scratch("retention");
        install_descriptor(&project, "enyo-anya", DESC);
        let first = compile(&project, &spec_json("m.gguf"), None).unwrap();
        assert_eq!(first.pruned, 0, "nothing to prune on the first compile");
        let second = compile(&project, &spec_json("other.gguf"), None).unwrap();
        // The superseded bundle dir + the old fix-node artifacts are gone…
        assert!(second.pruned >= 2, "expected bundle + orphan node pruned, got {}", second.pruned);
        assert!(!Path::new(&first.bundle_dir).exists());
        // …while every node the new manifest references survives.
        for n in &second.nodes {
            assert!(nodes_store(&project).join(&n.hash).exists(), "node {} missing", n.id);
        }
    }

    #[test]
    fn missing_descriptor_is_a_clear_compile_error() {
        let project = scratch("no-desc");
        let err = compile(&project, &spec_json("m.gguf"), None).unwrap_err();
        assert!(err.message.contains("Target descriptor not found"), "{err}");
        assert!(err.message.contains("enyo-anya.json"), "{err}");
    }
}
