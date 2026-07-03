import { describe, expect, it } from "vitest";
import { formatCommandLine, parseCommandLine } from "../command-line";

describe("parseCommandLine", () => {
  it("splits command and args on whitespace", () => {
    expect(parseCommandLine("npx -y @modelcontextprotocol/server-everything")).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    });
  });

  it("handles a bare command and extra whitespace", () => {
    expect(parseCommandLine("  my-server  ")).toEqual({ command: "my-server", args: [] });
  });

  it("groups quoted args (single and double)", () => {
    expect(parseCommandLine(`uvx "mcp server" --root '/tmp/my dir'`)).toEqual({
      command: "uvx",
      args: ["mcp server", "--root", "/tmp/my dir"],
    });
  });

  it("rejects empty input and unbalanced quotes", () => {
    expect(parseCommandLine("")).toBeNull();
    expect(parseCommandLine("   ")).toBeNull();
    expect(parseCommandLine(`npx "unclosed`)).toBeNull();
  });
});

describe("formatCommandLine", () => {
  it("round-trips, re-quoting args with spaces", () => {
    const line = formatCommandLine("uvx", ["mcp server", "--fast"]);
    expect(line).toBe(`uvx "mcp server" --fast`);
    expect(parseCommandLine(line)).toEqual({ command: "uvx", args: ["mcp server", "--fast"] });
  });
});
