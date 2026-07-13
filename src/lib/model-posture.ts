/**
 * Model capability classifier + posture recommendation (the thin↔thick dial).
 *
 * Extends the vision-only heuristics in `model-capabilities.ts` with the two
 * extra axes the posture spectrum needs:
 *   - native tool-calling support (does the model speak OpenAI `tools`/`tool_calls`?)
 *   - a strength class (`local-small | local-large | frontier`)
 * and folds them into a recommended **posture** and the size **profile** tier.
 *
 * All detection is string-based and best-effort — local runtimes don't reliably
 * advertise these over `/models`, and OpenAI-compatible endpoints expose no
 * `/api/show`. The safe default is the *thicker* posture (more host scaffolding):
 * an unknown model is assumed weak and tool-call-incapable, so it gets more help,
 * never less safety. Newer Ollama builds that DO report a `capabilities` list can
 * refine `nativeToolCalling` via {@link mergeServerCapabilities}.
 *
 * The host is agnostic about *which* agent realizes a posture — the spectrum
 * (None → thin → thick → orchestrated) is an intensity dial, and the emitted
 * env contract (`AGENT_TOOLCALL`/`AGENT_GATING`/`AGENT_LEASH`) is what a posture-
 * aware agent honors. See `docs/AKA-Architecture.md`.
 */

/** The host-side posture spectrum, ordered thin (least scaffolding) → thick. */
export type Posture = "none" | "thin" | "thick" | "orchestrated";

/** Coarse strength class derived from family + parameter size. */
export type StrengthClass = "local-small" | "local-large" | "frontier";

/** Size tier emitted as `AGENT_PROFILE` (kept compatible with `small|mid|large`). */
export type ProfileTier = "small" | "mid" | "large";

/** Ordered spectrum for rendering thin→thick. None is the max-autonomy endpoint. */
export const POSTURE_ORDER: Posture[] = ["none", "thin", "thick", "orchestrated"];

/** Short, agent-agnostic labels for the picker (no Änyä/Enyö hardcoding). */
export const POSTURE_LABEL: Record<Posture, string> = {
  none: "None",
  thin: "Light",
  thick: "Tight",
  orchestrated: "Orchestrated",
};

/** One-line descriptions for the picker rows. */
export const POSTURE_BLURB: Record<Posture, string> = {
  none: "no harness — maximum model autonomy (house safety still on)",
  thin: "light harness — native tool-calls, loose gating",
  thick: "tight harness — text ReAct, strict gating",
  orchestrated: "full orchestrator — least-privilege, short leash",
};

/**
 * Largest parameter count (in billions) mentioned in the id, e.g. `qwen2.5:72b`
 * → 72, `llama-3.1-8b-instruct` → 8. `null` when no size token is present
 * (most cloud ids). Picks the max so `mixtral-8x7b` reads as 7 (per-expert) and
 * `llama-3.1-405b` as 405.
 */
function sizeBillions(modelId: string): number | null {
  const m = modelId.toLowerCase();
  const matches = [...m.matchAll(/(\d+(?:\.\d+)?)\s*b(?![a-z])/g)];
  if (matches.length === 0) return null;
  return Math.max(...matches.map((x) => parseFloat(x[1])));
}

/**
 * Whether the model is a known frontier (cloud-class) family. Conservative: only
 * names that are effectively cloud-only flagships count, so a local distill with
 * a size token is still classified by its size, not its family name.
 */
export function isFrontierModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  // OpenAI flagships (gpt-4 / gpt-4o / gpt-4.1 / gpt-5 / chatgpt) — no end anchor,
  // so the `o`/`.1`/`-turbo` suffixes still match.
  if (/(^|[-_:/])gpt-?[45]/.test(m)) return true;
  if (m.includes("chatgpt")) return true;
  // o-series reasoning models (o1 / o3-mini / o4-mini), boundary-guarded so they
  // don't match an `o3` buried inside an unrelated word.
  if (/(^|[-_:/])o[1345]([-_:.]|$)/.test(m)) return true;
  // Anthropic Claude.
  if (m.includes("claude")) return true;
  // Google Gemini (not local Gemma).
  if (m.includes("gemini")) return true;
  // xAI Grok.
  if (/(^|[-_:/])grok([-_:.]|$)/.test(m)) return true;
  // Cohere Command-R+ flagship.
  if (m.includes("command-r-plus")) return true;
  return false;
}

/**
 * HINT ONLY — whether the model's *name* matches a known tool-calling family.
 *
 * NOT used to route the built-in loop's tool transport: that is decided by
 * evidence (`use-tool-support-store` — runtime-advertised capabilities +
 * observed behavior, with an optimistic try-native-first fallback in
 * `runAdaptiveToolLoop`), because AKA never hardcodes model opinions. This
 * heuristic survives solely as an advisory input to the external-agent
 * posture dial (`AGENT_TOOLCALL` env hint), where no runtime round-trip is
 * available at classification time.
 */
export function supportsNativeToolCalling(
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  // All current frontier families support tool-calling.
  if (isFrontierModel(m)) return true;
  // Qwen 2.5 / 3 (not the older qwen2 / qwen1.5).
  if (/qwen-?(2\.5|3)/.test(m)) return true;
  // Llama 3.1+ (3.0 did not ship tool-calling).
  if (/llama-?3\.(1|2|3)/.test(m)) return true;
  // Mistral family (recent) + Mixtral + Ministral + Nemo.
  if (/(mistral|mixtral|ministral|mistral-nemo|codestral)/.test(m)) return true;
  // Cohere Command-R / R+.
  if (/command-r/.test(m)) return true;
  // Purpose-built function-calling / tool-use families.
  if (/(firefunction|functionary|hermes|nous-hermes)/.test(m)) return true;
  // IBM Granite (3.x) advertises tools.
  if (/granite-?3/.test(m)) return true;
  return false;
}

/** Size tier emitted as `AGENT_PROFILE`. Unknown size → `mid` (safe middle). */
export function profileTier(modelId: string | null | undefined): ProfileTier {
  if (!modelId) return "mid";
  if (isFrontierModel(modelId)) return "large";
  const b = sizeBillions(modelId);
  if (b == null) return "mid";
  if (b < 10) return "small";
  if (b < 35) return "mid";
  return "large";
}

/** Strength class from family + size. Unknown → `local-small` (assume weakest). */
export function classifyStrength(
  modelId: string | null | undefined,
): StrengthClass {
  if (!modelId) return "local-small";
  if (isFrontierModel(modelId)) return "frontier";
  const b = sizeBillions(modelId);
  if (b != null && b >= 35) return "local-large";
  return "local-small";
}

/** The full capability read for a model id. */
export type ModelCapability = {
  strength: StrengthClass;
  nativeToolCalling: boolean;
  profile: ProfileTier;
  /** The recommended posture for this model — advisory only, never forced. */
  recommended: Posture;
};

/**
 * Recommend a posture from the strength class:
 *   frontier    → None      (max autonomy; strong models need no scaffolding)
 *   local-large → thin      (light harness)
 *   local-small → orchestrated (full orchestrator carries the weak model)
 * The user can always override; nothing is auto-applied unless the opt-in is set.
 */
export function recommendPosture(strength: StrengthClass): Posture {
  switch (strength) {
    case "frontier":
      return "none";
    case "local-large":
      return "thin";
    case "local-small":
      return "orchestrated";
  }
}

/** Classify a model across every axis and recommend a posture. */
export function classifyModel(
  modelId: string | null | undefined,
): ModelCapability {
  const strength = classifyStrength(modelId);
  return {
    strength,
    nativeToolCalling: supportsNativeToolCalling(modelId),
    profile: profileTier(modelId),
    recommended: recommendPosture(strength),
  };
}

/**
 * Refine a classification with a server-reported capability list (e.g. Ollama
 * `/api/show`'s `capabilities`, which includes `"tools"` for tool-call-capable
 * models). Server truth overrides the string heuristic for tool-calling only —
 * strength/size stay heuristic. Pass an empty/unknown list to leave it unchanged.
 */
export function mergeServerCapabilities(
  base: ModelCapability,
  serverCapabilities: string[] | null | undefined,
): ModelCapability {
  if (!serverCapabilities || serverCapabilities.length === 0) return base;
  const lc = serverCapabilities.map((c) => c.toLowerCase());
  return { ...base, nativeToolCalling: lc.includes("tools") };
}

/** The env dial a posture maps to. `null` for `none` (no agent is spawned). */
export type PostureDial = {
  /** `native` only when the posture wants it AND the model can do it. */
  toolcall: "native" | "text";
  gating: "loose" | "strict";
  /** Max autonomous steps before an orchestrator intervenes. */
  leash: number;
};

/**
 * Map a posture (plus whether the model can do native tool-calling) to the env
 * dial. A posture that *wants* native tool-calling still emits `text` when the
 * model can't do it — capability gates the dial, posture sets the intent.
 */
export function postureToDial(
  posture: Posture,
  nativeToolCalling: boolean,
): PostureDial | null {
  switch (posture) {
    case "none":
      // None spawns no agent — the dial is for subprocess agents only.
      return null;
    case "thin":
      return {
        toolcall: nativeToolCalling ? "native" : "text",
        gating: "loose",
        leash: 24,
      };
    case "thick":
      return { toolcall: "text", gating: "strict", leash: 12 };
    case "orchestrated":
      return { toolcall: "text", gating: "strict", leash: 6 };
  }
}
