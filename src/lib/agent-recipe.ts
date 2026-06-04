/**
 * Shareable agent "recipes" — a tiny JSON document that prefills the agent
 * registration form. AKA ships none; users and the community distribute them.
 * Importing a recipe is just "paste this JSON" → the form fills in.
 *
 * A recipe carries the same surface the form needs (name + command + ownership
 * + optional notes). The command is a terminal-style string with `{model}` /
 * `{base_url}` / `{task}` placeholders — see `agent-command.ts`.
 */

import { formatCommand } from "./agent-command";
import type { LLMOwnership } from "../stores/use-agents-store";

export const RECIPE_VERSION = 1;

export type AgentRecipe = {
  /** Schema version. Guards against importing a format we don't understand. */
  akaRecipe: number;
  name: string;
  command: string;
  llmOwnership?: LLMOwnership;
  notes?: string;
};

export type RecipeParseResult =
  | { ok: true; recipe: AgentRecipe }
  | { ok: false; error: string };

function isOwnership(v: unknown): v is LLMOwnership {
  return v === "aka" || v === "agent";
}

/**
 * Parse + validate a pasted/loaded recipe document. Accepts either a `command`
 * string or a structured `bin` (+ optional `args`) pair, normalising both to a
 * `command`. Returns a friendly error string rather than throwing so the UI can
 * surface it inline.
 */
export function parseRecipe(text: string): RecipeParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste a recipe first." };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "That isn't valid JSON." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "A recipe must be a JSON object." };
  }

  const obj = raw as Record<string, unknown>;

  if (!("akaRecipe" in obj)) {
    return { ok: false, error: 'Missing "akaRecipe" field — is this an AKA recipe?' };
  }
  if (typeof obj.akaRecipe !== "number") {
    return { ok: false, error: '"akaRecipe" must be a version number.' };
  }
  if (obj.akaRecipe > RECIPE_VERSION) {
    return {
      ok: false,
      error: `This recipe is version ${obj.akaRecipe}; this AKA understands up to ${RECIPE_VERSION}. Update AKA.`,
    };
  }

  // Command: explicit string, or build one from a structured bin (+ args).
  let command: string;
  if (typeof obj.command === "string" && obj.command.trim()) {
    command = obj.command.trim();
  } else if (typeof obj.bin === "string" && obj.bin.trim()) {
    const args = Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === "string")
      : [];
    command = formatCommand(obj.bin.trim(), args);
  } else {
    return { ok: false, error: 'Recipe has no "command" (or "bin").' };
  }

  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : command.split(/\s+/)[0] || "Agent";

  const recipe: AgentRecipe = { akaRecipe: RECIPE_VERSION, name, command };
  if (isOwnership(obj.llmOwnership)) recipe.llmOwnership = obj.llmOwnership;
  if (typeof obj.notes === "string" && obj.notes.trim()) {
    recipe.notes = obj.notes.trim();
  }
  return { ok: true, recipe };
}

/** Build a recipe from a registered agent's fields, for export/sharing. */
export function toRecipe(input: {
  name: string;
  bin: string;
  args: string[];
  llmOwnership: LLMOwnership;
  notes?: string;
}): AgentRecipe {
  const recipe: AgentRecipe = {
    akaRecipe: RECIPE_VERSION,
    name: input.name,
    command: formatCommand(input.bin, input.args),
    llmOwnership: input.llmOwnership,
  };
  if (input.notes && input.notes.trim()) recipe.notes = input.notes.trim();
  return recipe;
}

/** Pretty-print a recipe as the JSON users copy/save and share. */
export function recipeToJson(recipe: AgentRecipe): string {
  // Stable key order: version → name → command → ownership → notes.
  const ordered: AgentRecipe = {
    akaRecipe: recipe.akaRecipe,
    name: recipe.name,
    command: recipe.command,
    ...(recipe.llmOwnership ? { llmOwnership: recipe.llmOwnership } : {}),
    ...(recipe.notes ? { notes: recipe.notes } : {}),
  };
  return JSON.stringify(ordered, null, 2);
}
