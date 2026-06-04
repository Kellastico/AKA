import { describe, expect, it } from "vitest";
import {
  formatCommand,
  hasModelPlaceholder,
  hasTaskPlaceholder,
  parseCommand,
} from "../agent-command";

describe("parseCommand", () => {
  it("splits a plain command into bin + args", () => {
    expect(parseCommand("opencode run --model x")).toEqual({
      bin: "opencode",
      args: ["run", "--model", "x"],
    });
  });

  it("returns empty bin for blank / whitespace input", () => {
    expect(parseCommand("")).toEqual({ bin: "", args: [] });
    expect(parseCommand("   \t ")).toEqual({ bin: "", args: [] });
  });

  it("collapses runs of whitespace between tokens", () => {
    expect(parseCommand("  aider    --yes   \t --message  ")).toEqual({
      bin: "aider",
      args: ["--yes", "--message"],
    });
  });

  it("keeps placeholders intact as ordinary tokens", () => {
    expect(
      parseCommand("aider --model openai/{model} --message {task}"),
    ).toEqual({
      bin: "aider",
      args: ["--model", "openai/{model}", "--message", "{task}"],
    });
  });

  it("groups double-quoted spans into one token", () => {
    expect(parseCommand('python3 agent.py "hello world" {task}')).toEqual({
      bin: "python3",
      args: ["agent.py", "hello world", "{task}"],
    });
  });

  it("groups single-quoted spans and treats their contents literally", () => {
    expect(parseCommand("sh -c 'echo $AKA_TASK'")).toEqual({
      bin: "sh",
      args: ["-c", "echo $AKA_TASK"],
    });
  });

  it("honours backslash-escaped spaces", () => {
    expect(parseCommand("/opt/My\\ Agent/run --go")).toEqual({
      bin: "/opt/My Agent/run",
      args: ["--go"],
    });
  });

  it("unescapes \\\" and \\\\ inside double quotes", () => {
    expect(parseCommand('x --msg "she said \\"hi\\""')).toEqual({
      bin: "x",
      args: ["--msg", 'she said "hi"'],
    });
  });

  it("produces an explicit empty-string token for ''", () => {
    expect(parseCommand("agent --flag ''")).toEqual({
      bin: "agent",
      args: ["--flag", ""],
    });
  });
});

describe("formatCommand", () => {
  it("returns '' for an empty bin", () => {
    expect(formatCommand("", [])).toBe("");
  });

  it("leaves flags, paths, models, and placeholders unquoted", () => {
    expect(
      formatCommand("aider", ["--model", "openai/{model}", "--message", "{task}"]),
    ).toBe("aider --model openai/{model} --message {task}");
  });

  it("quotes tokens that contain spaces", () => {
    expect(formatCommand("python3", ["agent.py", "hello world"])).toBe(
      'python3 agent.py "hello world"',
    );
  });

  it("quotes an empty-string arg", () => {
    expect(formatCommand("agent", ["--flag", ""])).toBe('agent --flag ""');
  });
});

describe("round-trip", () => {
  const cases = [
    "opencode run --model ollama/{model} {task}",
    "aider --model openai/{model} --openai-api-base {base_url} --yes-always --message {task}",
    'python3 agent.py "a b c" {task}',
    'sh "/opt/My Agent/wrap.sh"',
    "claude -p {task}",
  ];
  it.each(cases)("parse∘format is stable for %s", (cmd) => {
    const { bin, args } = parseCommand(cmd);
    const round = parseCommand(formatCommand(bin, args));
    expect(round).toEqual({ bin, args });
  });
});

describe("placeholder helpers", () => {
  it("detects {task} and {model}", () => {
    expect(hasTaskPlaceholder("x {task}")).toBe(true);
    expect(hasTaskPlaceholder("x --no-prompt")).toBe(false);
    expect(hasModelPlaceholder("x --model {model}")).toBe(true);
    expect(hasModelPlaceholder("x")).toBe(false);
  });
});
