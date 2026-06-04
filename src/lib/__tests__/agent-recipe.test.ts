import { describe, expect, it } from "vitest";
import {
  parseRecipe,
  recipeToJson,
  toRecipe,
  RECIPE_VERSION,
} from "../agent-recipe";

const valid = JSON.stringify({
  akaRecipe: 1,
  name: "Aider (Ollama)",
  command: "aider --model openai/{model} --message {task}",
  llmOwnership: "aka",
  notes: "Works with any OpenAI-compatible server.",
});

describe("parseRecipe", () => {
  it("parses a well-formed recipe", () => {
    const r = parseRecipe(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.name).toBe("Aider (Ollama)");
    expect(r.recipe.command).toContain("{task}");
    expect(r.recipe.llmOwnership).toBe("aka");
    expect(r.recipe.notes).toContain("OpenAI-compatible");
  });

  it("rejects blank input", () => {
    expect(parseRecipe("   ")).toEqual({ ok: false, error: expect.any(String) });
  });

  it("rejects non-JSON", () => {
    const r = parseRecipe("not json {");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/valid JSON/i);
  });

  it("rejects a JSON array / non-object", () => {
    expect(parseRecipe("[1,2,3]").ok).toBe(false);
    expect(parseRecipe('"a string"').ok).toBe(false);
  });

  it("rejects a document with no akaRecipe field", () => {
    const r = parseRecipe(JSON.stringify({ name: "x", command: "x {task}" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/akaRecipe/);
  });

  it("rejects a future schema version", () => {
    const r = parseRecipe(JSON.stringify({ akaRecipe: 999, command: "x {task}" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/update aka/i);
  });

  it("builds the command from a structured bin + args", () => {
    const r = parseRecipe(
      JSON.stringify({ akaRecipe: 1, bin: "opencode", args: ["run", "{task}"] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.command).toBe("opencode run {task}");
  });

  it("derives a name from the command when none is given", () => {
    const r = parseRecipe(JSON.stringify({ akaRecipe: 1, command: "claude -p {task}" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.name).toBe("claude");
  });

  it("ignores an invalid llmOwnership value", () => {
    const r = parseRecipe(
      JSON.stringify({ akaRecipe: 1, command: "x {task}", llmOwnership: "bogus" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.llmOwnership).toBeUndefined();
  });
});

describe("toRecipe / recipeToJson round-trip", () => {
  it("exports an agent and re-imports to the same command", () => {
    const recipe = toRecipe({
      name: "My Agent",
      bin: "aider",
      args: ["--model", "openai/{model}", "--message", "{task}"],
      llmOwnership: "aka",
    });
    expect(recipe.akaRecipe).toBe(RECIPE_VERSION);
    const json = recipeToJson(recipe);
    const back = parseRecipe(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.recipe.command).toBe("aider --model openai/{model} --message {task}");
    expect(back.recipe.name).toBe("My Agent");
    expect(back.recipe.llmOwnership).toBe("aka");
  });

  it("omits notes from JSON when absent", () => {
    const json = recipeToJson(
      toRecipe({ name: "x", bin: "x", args: [], llmOwnership: "agent" }),
    );
    expect(json).not.toContain("notes");
  });
});
