# llm-provider

## Status
Agnostic OpenAI-compatible runtime connection layer wired end-to-end.

## What it does
- Probes localhost ports for known OpenAI-compatible runtimes (Ollama, LM Studio,
  llama.cpp) at startup and on demand.
- Lets the user pick a detected runtime or enter a custom `base_url` + optional
  API key (validated against `/v1/models` before saving).
- Persists the active `RuntimeConfig` in the app's global `.äkä/config.json`.
- Lists available models from the selected runtime via `/v1/models` and exposes
  them through `ModelPicker`.
- Re-probes runtime health every 30s; on transition to unhealthy, surfaces a
  toast and disables the send button via `useRuntimeStore`.
- Single inference entrypoint: `callLlm(messages, model?)` hits the active
  runtime's `/v1/chat/completions`.
- Browses and downloads GGUF weights for the built-in runtime: Manage Models
  lists what you have, and a HuggingFace picker gets you anything on the hub.

## Manage Models
The Models modal's main list. **It shows only models that are actually on
disk** — plus any download still in flight, so closing the HuggingFace panel
mid-download doesn't hide the progress bar or the cancel button.

AKA no longer ships a catalog of suggestions. `CURATED_MODELS` (four
ÄKÄ-tested entries advertised alongside your own files) is gone; the
`CuratedModel` *type* survives only as the descriptor a download is described
by, which the HuggingFace flow builds per file. Rows are therefore derived
entirely from the file on disk: name from the filename, size from its bytes.

- **RAM is estimated, and says so.** Nothing on disk records what a model
  needs, so `installedBrowserModels` runs the same `estimateMinRamGb` the HF
  download path uses (weights + 1.5GB, rounded up) and the card labels it
  "~NGB RAM est." rather than presenting it as a spec.
- **`fitsHardware`** drives both the per-card badge ("Fits this device" /
  "Over NGB RAM") and the All / Fits-this-device filter. Unknown RAM on
  either side counts as fitting — a probe failure must never hide a model.
- **Storage is first-class.** The machine's specs and the models folder share
  one panel under the header: GPU + RAM, then model count, total on disk, the
  path in mono, and a Reveal button. Each card also carries its own filename
  with a click-to-reveal. (All models live in one flat directory, so reveal
  opens that folder rather than pretending to select a single file.)
- The old All / Installed / Light / Standard / Pro pills are gone: everything
  listed is installed, and tier buckets don't separate a handful of files.

## HuggingFace picker
Search-first browser over the GGUF side of the hub, reached from Models →
"Add Model (via Huggingface)".

- **A row is a repo, shown through one quant.** The row leads with the quant the
  user filtered on, or the sensible default (`Q4_K_M` and friends), as a hint at
  what the repo carries. Its affordance reads "View & Download Variants ›" —
  plain text and a caret, since it navigates rather than acts. The variants page
  it opens is headed with a count of the distinct downloadable quants it offers.
- **A search is one request, and stays one.** `hf_search_models` asks for
  `expand[]=gguf,siblings,…`, so parameter count, task tag and the repo's quant
  labels all come back with the search. Rows show no size, so nothing per-row is
  fetched while scrolling; a repo's listing is pulled only when it's opened
  (`ensureHfRepoFiles`), then cached, so returning to it is instant.
- **Sizes are real bytes, and only shown where they're exact.** Every size in
  the picker comes from the repo listing's LFS metadata and appears on the file
  list's own Download buttons. Nothing is estimated from the parameter count — a
  bits-per-weight derivation lands within ~5% typically but ~16% on dynamic
  quants, and misreads `mmproj` projectors by orders of magnitude.
- **Quant labels are parsed from filenames** (`…-Q4_K_M.gguf` → `Q4_K_M`,
  including the `IQ`/`TQ` families and unsloth's `UD-` prefix) over the same
  top-level, non-sharded set
  `hf_list_gguf_files` returns, so a facet can never offer a quant the file list
  won't show. A vision projector (`mmproj-…-BF16.gguf`) carries no quant — its
  precision describes the projector, not the model.
- **Labels are displayed prettified, filtered canonically.** `prettyQuant` in
  `hf-display.ts` renders `Q4_K_M` → `Q4 M`, `IQ4_XXS` → `IQ4 XXS`,
  `UD-Q4_K_XL` → `UD Q4 XL`, `Q8_0` → `Q8`. Only `K` and a trailing `_0` drop
  out — neither tells one quant from another. Every identifying marker stays
  (`IQ`, `UD`), so two quants can never render the same label: a test walks every
  known variant, with and without `UD-`, and asserts the labels are distinct. The canonical value is
  still the filter key and the hover title.
- **Sort By is server-side** (a HuggingFace `sort` param, clamped to an
  allowlist in Rust); **Created By** and **Quantizations** are client-side facets
  over the current 50-hit result set. Each facet counts *after* the other has
  narrowed things, so the two can't be combined into an empty list.
- **Avatars are local initials tiles.** AKA is offline-first — rows never fetch
  images from HuggingFace's CDN. The header's HuggingFace mark is bundled from
  `src/assets/`, not hotlinked.
- Back steps out one level at a time: a repo's files → results → the empty
  prompt → closed.

## Files
- `use-runtime-store.ts` — Zustand store, bootstrap + health polling.
- `ConnectionPanel.tsx` — detection list, manual entry, health dots.
- `RuntimeToasts.tsx` — disconnect toast surface.
- `ModelBrowser.tsx` — Manage Models list + the HuggingFace picker.
- `use-model-browser-store.ts` — downloads, RAM gate, HF search/facet state.
- `curated-models.ts` — the `CuratedModel` download descriptor. No catalog
  any more; kept under this name so the HF download path is untouched.
- `hf-display.ts` — quant/param/size label rules for the picker (unit-tested).

## Constraints
- "Ollama" appears only in the default URL string and the detection probe list
  (Rust + TS). Nowhere else in logic.
- All LLM calls funnel through `callLlm`.
- HuggingFace requests are read-only `GET`s, host-pinned through
  `normalize_repo`; the only artifact written to disk is a validated `.gguf`.
