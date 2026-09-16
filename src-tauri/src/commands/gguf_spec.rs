//! Read a model's shape from its GGUF header, without loading it.
//!
//! Selecting a model in the picker doesn't load it, and loading a 9 GB model
//! just to find out what it would cost is absurd. But the numbers that decide
//! whether a context window is safe — layer count, head counts, embedding
//! width — all sit in the GGUF metadata block at the very front of the file.
//! Reading a few kilobytes of header answers the question in microseconds.
//!
//! This is what lets the Context Window panel price a model the moment it is
//! picked, rather than only after the first message has already committed the
//! machine to the allocation.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

/// Everything needed to price a context window for one model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub filename: String,
    /// Weight file size in bytes.
    pub size_bytes: u64,
    /// Bytes of KV cache per token of context: `2 * n_layer * head_dim *
    /// n_head_kv * sizeof(f16)`. Scales linearly with the window.
    pub kv_bytes_per_token: u64,
    /// Largest context the model was trained for.
    pub n_ctx_train: u32,
    /// Largest context whose KV cache fits this machine alongside the weights.
    /// This — not `n_ctx_train` — is the number that decides danger: a trained
    /// window is routinely several times what the hardware can hold.
    pub max_fitting_ctx: u32,
    pub architecture: String,
    /// Whether this model's chat template exposes an `enable_thinking` switch.
    ///
    /// Reasoning is a minority feature, not a universal one: of three models
    /// on this machine, two have the switch and one has no reasoning step at
    /// all. The control is shown only where the model actually offers it,
    /// rather than presented everywhere and silently doing nothing.
    pub supports_reasoning_toggle: bool,
}

/// Share of RAM a model plus its cache may occupy before the machine suffers.
/// Mirrors `SAFE_RAM_FRACTION` in the runtime so both agree on what "fits".
const SAFE_RAM_FRACTION: f64 = 0.75;
/// Smallest context llama.cpp can build.
const MIN_CTX: u32 = 256;
/// Cap on how much header we will read before giving up — a malformed or
/// hostile file must not be able to make us allocate without bound.
const MAX_HEADER_BYTES: u64 = 32 * 1024 * 1024;
/// Longest metadata string we will accept, for the same reason.
const MAX_STRING_LEN: u64 = 1 << 20;

/// GGUF metadata value types we can traverse. We only *read* integers, but
/// every type has to be skippable to reach the keys that matter.
mod ty {
    pub const UINT8: u32 = 0;
    pub const INT8: u32 = 1;
    pub const UINT16: u32 = 2;
    pub const INT16: u32 = 3;
    pub const UINT32: u32 = 4;
    pub const INT32: u32 = 5;
    pub const FLOAT32: u32 = 6;
    pub const BOOL: u32 = 7;
    pub const STRING: u32 = 8;
    pub const ARRAY: u32 = 9;
    pub const UINT64: u32 = 10;
    pub const INT64: u32 = 11;
    pub const FLOAT64: u32 = 12;
}

struct Reader<R: Read + Seek> {
    inner: R,
}

impl<R: Read + Seek> Reader<R> {
    fn u32(&mut self) -> Option<u32> {
        let mut b = [0u8; 4];
        self.inner.read_exact(&mut b).ok()?;
        Some(u32::from_le_bytes(b))
    }
    fn u64(&mut self) -> Option<u64> {
        let mut b = [0u8; 8];
        self.inner.read_exact(&mut b).ok()?;
        Some(u64::from_le_bytes(b))
    }
    fn string(&mut self) -> Option<String> {
        let n = self.u64()?;
        if n > MAX_STRING_LEN {
            return None;
        }
        let mut buf = vec![0u8; n as usize];
        self.inner.read_exact(&mut buf).ok()?;
        Some(String::from_utf8_lossy(&buf).into_owned())
    }
    fn skip(&mut self, n: i64) -> Option<()> {
        self.inner.seek(SeekFrom::Current(n)).ok().map(|_| ())
    }
    fn pos(&mut self) -> Option<u64> {
        self.inner.stream_position().ok()
    }

    /// Read a scalar as u64 where it makes sense, skipping it either way.
    /// Returns `None` for non-integer types — the caller only wants integers.
    fn value(&mut self, t: u32) -> Option<Option<u64>> {
        match t {
            ty::UINT8 | ty::INT8 | ty::BOOL => {
                let mut b = [0u8; 1];
                self.inner.read_exact(&mut b).ok()?;
                Some(Some(b[0] as u64))
            }
            ty::UINT16 | ty::INT16 => {
                let mut b = [0u8; 2];
                self.inner.read_exact(&mut b).ok()?;
                Some(Some(u16::from_le_bytes(b) as u64))
            }
            ty::UINT32 | ty::INT32 => Some(Some(self.u32()? as u64)),
            ty::FLOAT32 => {
                self.skip(4)?;
                Some(None)
            }
            ty::UINT64 | ty::INT64 => Some(Some(self.u64()?)),
            ty::FLOAT64 => {
                self.skip(8)?;
                Some(None)
            }
            ty::STRING => {
                self.string()?;
                Some(None)
            }
            ty::ARRAY => {
                let elem = self.u32()?;
                let len = self.u64()?;
                for _ in 0..len {
                    self.value(elem)?;
                }
                Some(None)
            }
            // Unknown type: we can't know its width, so we can't safely skip it.
            _ => None,
        }
    }
}

/// Parse the integer metadata we need out of a GGUF header.
///
/// Returns `None` for anything that isn't a readable GGUF — a truncated file,
/// an unfamiliar metadata type, a header larger than `MAX_HEADER_BYTES`. The
/// caller treats that as "unknown", never as an error.
fn read_header(path: &Path) -> Option<(String, u32, u32, u32, u32, u32, bool)> {
    let file = File::open(path).ok()?;
    let mut r = Reader {
        inner: BufReader::new(file),
    };

    let mut magic = [0u8; 4];
    r.inner.read_exact(&mut magic).ok()?;
    if &magic != b"GGUF" {
        return None;
    }
    let _version = r.u32()?;
    let _tensor_count = r.u64()?;
    let kv_count = r.u64()?;

    let mut arch = String::new();
    let mut supports_reasoning_toggle = false;
    let mut block_count = None;
    let mut embedding_length = None;
    let mut head_count = None;
    let mut head_count_kv = None;
    let mut context_length = None;

    for _ in 0..kv_count {
        if r.pos()? > MAX_HEADER_BYTES {
            return None;
        }
        let key = r.string()?;
        let t = r.u32()?;

        // The architecture is a string; everything else we want is an integer.
        if key == "general.architecture" && t == ty::STRING {
            arch = r.string()?;
            continue;
        }
        // The chat template is the only place that says whether the model has
        // a reasoning step to switch off.
        if key == "tokenizer.chat_template" && t == ty::STRING {
            let tpl = r.string()?;
            supports_reasoning_toggle = tpl.contains("enable_thinking");
            continue;
        }

        let v = r.value(t)?;
        // Keys are namespaced by architecture (`qwen2.block_count`), and the
        // architecture key can appear after the fields it names — so match on
        // the suffix rather than reconstructing the full key.
        let Some(n) = v else { continue };
        if key.ends_with(".block_count") {
            block_count = Some(n);
        } else if key.ends_with(".embedding_length") {
            embedding_length = Some(n);
        } else if key.ends_with(".attention.head_count") {
            head_count = Some(n);
        } else if key.ends_with(".attention.head_count_kv") {
            head_count_kv = Some(n);
        } else if key.ends_with(".context_length") {
            context_length = Some(n);
        }
    }

    Some((
        arch,
        block_count? as u32,
        embedding_length? as u32,
        head_count? as u32,
        head_count_kv? as u32,
        context_length.unwrap_or(0) as u32,
        supports_reasoning_toggle,
    ))
}

fn total_ram_bytes() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory()
}

/// Largest context whose KV cache fits alongside the weights within
/// `SAFE_RAM_FRACTION` of system RAM.
pub fn max_fitting_ctx(kv_bytes_per_token: u64, weights_bytes: u64) -> u32 {
    if kv_bytes_per_token == 0 {
        return u32::MAX;
    }
    let budget = total_ram_bytes() as f64 * SAFE_RAM_FRACTION;
    let left = budget - weights_bytes as f64;
    if left <= 0.0 {
        return MIN_CTX;
    }
    let n = (left / kv_bytes_per_token as f64) as u64;
    u32::try_from(n).unwrap_or(u32::MAX).max(MIN_CTX)
}

/// Build a spec for one model file. `None` when the header can't be read.
pub fn spec_for(path: &Path, filename: String) -> Option<ModelSpec> {
    let size_bytes = std::fs::metadata(path).ok()?.len();
    let (arch, n_layer, n_embd, n_head, n_head_kv, n_ctx_train, supports_reasoning_toggle) =
        read_header(path)?;
    if n_head == 0 || n_layer == 0 {
        return None;
    }

    // Grouped-query attention: the cache is sized on the KV head count, which
    // is often a fraction of the attention head count.
    let head_dim = n_embd as u64 / n_head as u64;
    const KV_ELEM_BYTES: u64 = 2; // llama.cpp keeps K and V in f16
    let kv_bytes_per_token = 2 * n_layer as u64 * head_dim * n_head_kv as u64 * KV_ELEM_BYTES;

    Some(ModelSpec {
        filename,
        size_bytes,
        kv_bytes_per_token,
        n_ctx_train,
        max_fitting_ctx: max_fitting_ctx(kv_bytes_per_token, size_bytes),
        architecture: arch,
        supports_reasoning_toggle,
    })
}

/// Resolve an Ollama model name to the GGUF blob backing it.
///
/// Ollama stores models as OCI-style manifests pointing at content-addressed
/// blobs, and the blob for the `…image.model` layer is a plain GGUF file —
/// verified by its magic bytes, same as any other. So the same header read
/// that prices AKA's own models works for Ollama's, with no server involved.
///
/// `None` when Ollama isn't installed, the model isn't pulled, or the layout
/// differs from what's expected. The caller shows nothing rather than guessing.
fn ollama_blob_for(model: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let root = std::path::PathBuf::from(home).join(".ollama/models");

    // `qwen2.5-coder:7b` → `library/qwen2.5-coder/7b`; a namespaced
    // `user/model:tag` keeps its namespace.
    let (name, tag) = model.split_once(':').unwrap_or((model, "latest"));
    let rel = if name.contains('/') {
        format!("{name}/{tag}")
    } else {
        format!("library/{name}/{tag}")
    };
    // Manifests live under a registry directory; try the default first, then
    // any other registry present.
    let mut candidates = vec![root.join("manifests/registry.ollama.ai").join(&rel)];
    if let Ok(entries) = std::fs::read_dir(root.join("manifests")) {
        for e in entries.flatten() {
            candidates.push(e.path().join(&rel));
        }
    }
    let manifest_path = candidates.into_iter().find(|p| p.is_file())?;

    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let digest = manifest
        .get("layers")?
        .as_array()?
        .iter()
        .find(|l| {
            l.get("mediaType").and_then(|m| m.as_str())
                == Some("application/vnd.ollama.image.model")
        })?
        .get("digest")?
        .as_str()?
        .replace(':', "-");

    let blob = root.join("blobs").join(digest);
    blob.is_file().then_some(blob)
}

/// Read the shape of an Ollama-managed model, without going through Ollama.
///
/// This prices the model and its context window exactly as for a built-in one.
/// It deliberately does NOT imply the window can be *set*: AKA speaks the
/// OpenAI-compatible API to every runtime, and Ollama's compatibility layer
/// ignores `num_ctx` (verified — a request carrying it still loaded at the
/// server's own default). Ollama's context is set in Ollama.
#[tauri::command]
pub fn inspect_ollama_model(model: String) -> Result<Option<ModelSpec>, String> {
    let Some(blob) = ollama_blob_for(&model) else {
        return Ok(None);
    };
    Ok(spec_for(&blob, model))
}

/// Read the shape of a model in the models directory without loading it.
///
/// Used when the picker selection changes, so the Context Window panel can
/// price the newly-picked model immediately instead of waiting for a message
/// to trigger a load.
#[tauri::command]
pub fn inspect_model(
    app: tauri::AppHandle,
    filename: String,
) -> Result<Option<ModelSpec>, String> {
    let safe = super::models::safe_filename(&filename)?;
    let path = super::models::models_dir(&app).join(safe);
    if !path.exists() {
        return Ok(None);
    }
    Ok(spec_for(&path, safe.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_junk_file_reads_as_unknown() {
        assert!(read_header(Path::new("/nonexistent/model.gguf")).is_none());
    }

    #[test]
    fn a_non_gguf_file_reads_as_unknown() {
        let dir = std::env::temp_dir().join("aka-gguf-spec-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("not-a-model.gguf");
        std::fs::write(&p, b"this is not a gguf file at all").unwrap();
        assert!(read_header(&p).is_none());
        assert!(spec_for(&p, "not-a-model.gguf".into()).is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn an_unknown_kv_cost_is_never_clamped() {
        // No basis to clamp on means don't invent one.
        assert_eq!(max_fitting_ctx(0, 8 << 30), u32::MAX);
    }

    #[test]
    fn weights_larger_than_the_budget_still_leave_a_buildable_window() {
        // A model too big for the machine must not produce a zero-length
        // context, which llama.cpp cannot build at all.
        assert_eq!(max_fitting_ctx(196_608, u64::MAX / 2), MIN_CTX);
    }
}

#[cfg(test)]
mod real_model_tests {
    use super::*;

    /// Reads the actual models on this machine when they're present, and skips
    /// cleanly on a machine (or CI box) that doesn't have them.
    #[test]
    fn reads_real_models_when_available() {
        let dir = dirs_models();
        let Some(dir) = dir else { return };
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("gguf") {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let Some(spec) = spec_for(&path, name.clone()) else {
                continue;
            };
            seen += 1;
            println!(
                "{:<36} kv/token {:>9}  trained {:>8}  fits {:>8}  reasoning-switch: {}",
                name,
                spec.kv_bytes_per_token,
                spec.n_ctx_train,
                spec.max_fitting_ctx,
                if spec.supports_reasoning_toggle { "yes" } else { "no" }
            );
            assert!(spec.kv_bytes_per_token > 0, "{name} reported no KV cost");
            assert!(spec.max_fitting_ctx >= MIN_CTX);
        }
        if seen > 0 {
            println!("read {seen} model(s)");
        }
    }

    /// Reads Ollama's own store when it's present, skipping cleanly when not.
    #[test]
    fn reads_ollama_models_when_available() {
        let Some(names) = ollama_model_names() else { return };
        let mut read = 0;
        for name in names {
            let Some(blob) = super::ollama_blob_for(&name) else {
                continue;
            };
            let Some(spec) = spec_for(&blob, name.clone()) else {
                continue;
            };
            read += 1;
            println!(
                "{:<28} kv/token {:>9}  trained {:>8}  fits {:>8}  reasoning-switch: {}",
                name,
                spec.kv_bytes_per_token,
                spec.n_ctx_train,
                spec.max_fitting_ctx,
                if spec.supports_reasoning_toggle { "yes" } else { "no" }
            );
            assert!(spec.kv_bytes_per_token > 0, "{name} reported no KV cost");
        }
        if read > 0 {
            println!("read {read} Ollama model(s) without contacting the server");
        }
    }

    /// Enumerate `library/<name>/<tag>` under Ollama's manifests directory.
    fn ollama_model_names() -> Option<Vec<String>> {
        let home = std::env::var("HOME").ok()?;
        let lib = std::path::PathBuf::from(home)
            .join(".ollama/models/manifests/registry.ollama.ai/library");
        if !lib.is_dir() {
            return None;
        }
        let mut out = Vec::new();
        for model in std::fs::read_dir(&lib).ok()?.flatten() {
            let name = model.file_name().to_string_lossy().to_string();
            for tag in std::fs::read_dir(model.path()).ok()?.flatten() {
                out.push(format!("{name}:{}", tag.file_name().to_string_lossy()));
            }
        }
        Some(out)
    }

    fn dirs_models() -> Option<std::path::PathBuf> {
        let home = std::env::var("HOME").ok()?;
        let p = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.aka.app/models");
        p.is_dir().then_some(p)
    }
}
