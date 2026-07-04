import { describe, expect, it } from "vitest";
import { createReActExtrasParser, isReActExtra } from "../extras";
import { parserForAgent } from "../index";
import type { AgentEvent } from "../types";

const feedAll = (parser: { feed: (l: string) => AgentEvent[] }, lines: string[]) =>
  lines.flatMap((l) => parser.feed(l));

describe("isReActExtra", () => {
  it("matches XML tool calls and provider-error dumps", () => {
    expect(isReActExtra(`<tool_call>read_file path="/x/index.html" />`)).toBe(true);
    expect(isReActExtra(`  <tool_call>{"name":"list_directory"}</tool_call>`)).toBe(true);
    expect(isReActExtra(`[sub-agent error: RateLimitError: Error code: 429 - {}]`)).toBe(true);
    expect(isReActExtra(`orch] ERROR during step 1: RateLimitError: Error code: 429 - {}`)).toBe(true);
  });

  it("does NOT match ordinary prose (false positives hide real content)", () => {
    expect(isReActExtra("Thought: I should read the file.")).toBe(false);
    expect(isReActExtra("The build failed with an error earlier.")).toBe(false);
    expect(isReActExtra("Here is a <div> in the HTML.")).toBe(false);
    expect(isReActExtra("Answer: done.")).toBe(false);
  });
});

describe("XML tool-call parsing", () => {
  it("turns a self-closing attr form into paired chip events", () => {
    const parser = createReActExtrasParser();
    const events = parser.feed(
      `<tool_call>read_file path="/Users/k/Websites/Ikemenogo.Co/index.html" />`,
    );
    expect(events).toEqual([
      {
        type: "tool_start",
        name: "read_file",
        kind: "read",
        path: "/Users/k/Websites/Ikemenogo.Co/index.html",
        input: `path="/Users/k/Websites/Ikemenogo.Co/index.html"`,
      },
      {
        type: "tool_end",
        ok: true,
        path: "/Users/k/Websites/Ikemenogo.Co/index.html",
      },
    ]);
  });

  it("classifies list_directory as a search and keeps its path", () => {
    const parser = createReActExtrasParser();
    const [start] = parser.feed(`<tool_call>list_directory path="/Users/k/work" />`);
    expect(start).toMatchObject({ type: "tool_start", name: "list_directory", kind: "search" });
  });

  it("handles the JSON body form", () => {
    const parser = createReActExtrasParser();
    const [start] = parser.feed(
      `<tool_call>{"name":"read_file","arguments":{"path":"src/App.tsx"}}</tool_call>`,
    );
    expect(start).toMatchObject({ type: "tool_start", name: "read_file", kind: "read", path: "src/App.tsx" });
  });

  it("drops a malformed/empty tool call rather than leaking it", () => {
    const parser = createReActExtrasParser();
    expect(parser.feed(`<tool_call>{bad json</tool_call>`)).toEqual([]);
    expect(parser.feed(`<tool_call> />`)).toEqual([]);
  });
});

describe("provider-error cleanup", () => {
  it("reduces a per-day rate-limit dump to one clean line, no user_id/metadata", () => {
    const raw =
      `[sub-agent error: RateLimitError: Error code: 429 - {'error': {'message': ` +
      `'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free ` +
      `model requests per day', 'code': 429, 'metadata': {'headers': ` +
      `{'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0'}, 'provider_name': None}}, ` +
      `'user_id': 'user_3FqGywuT79QFEdVmWhbAS9hkQ94'}]`;
    const [event] = createReActExtrasParser().feed(raw);
    expect(event.type).toBe("text");
    const text = (event as { type: "text"; text: string }).text;
    expect(text).toContain("RateLimitError 429");
    expect(text).toContain("Rate limit exceeded: free-models-per-day");
    expect(text).not.toContain("user_id");
    expect(text).not.toContain("X-RateLimit-Limit");
    expect(text).not.toContain("metadata");
  });

  it("surfaces the upstream `raw` detail and the provider link", () => {
    const raw =
      `orch] ERROR during step 1: RateLimitError: Error code: 429 - {'error': {'message': ` +
      `'Provider returned error', 'code': 429, 'metadata': {'raw': ` +
      `'openai/gpt-oss-120b:free is temporarily rate-limited upstream. Please retry shortly, ` +
      `or add your own key: https://openrouter.ai/settings/integrations', ` +
      `'provider_name': 'OpenInference', 'is_byok': False}}, 'user_id': 'user_3Fq'}]`;
    const [event] = createReActExtrasParser().feed(raw);
    const text = (event as { type: "text"; text: string }).text;
    expect(text).toContain("429");
    expect(text).toContain("temporarily rate-limited upstream");
    expect(text).toContain("https://openrouter.ai/settings/integrations");
    expect(text).not.toContain("is_byok");
  });
});

describe("integration through parserForAgent (default ReAct agent)", () => {
  it("renders <tool_call> as chips and keeps real ReAct scaffolding working", () => {
    const parser = parserForAgent("anya");
    const events = feedAll(parser, [
      `<tool_call>read_file path="/x/index.html" />`,
      "Thought: now I understand the layout.",
      "Answer: there are three projects.",
    ]);
    // The tool call became structured events…
    expect(events.some((e) => e.type === "tool_start" && e.name === "read_file")).toBe(true);
    // …and ReAct scaffolding still parses (Thought → reasoning, Answer → text).
    expect(events.some((e) => e.type === "reasoning_start")).toBe(true);
    expect(events.some((e) => e.type === "text" && /three projects/.test(e.text))).toBe(true);
  });

  it("cleans a provider-error line even mixed into agent output", () => {
    const parser = parserForAgent("anya");
    const events = feedAll(parser, [
      `orch] ERROR during step 1: RateLimitError: Error code: 429 - {'error': {'message': 'Provider returned error', 'code': 429}}`,
    ]);
    const textual = events.filter((e) => e.type === "text") as { type: "text"; text: string }[];
    expect(textual.some((e) => e.text.includes("429") && !e.text.includes("'code'"))).toBe(true);
  });
});
