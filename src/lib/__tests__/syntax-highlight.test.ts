import { describe, expect, it } from "vitest";
import { tokenizeShell, tokenizeCode, isCommandLine } from "../syntax-highlight";

/**
 * Collapse tokens to `kind:text` pairs for terse asserts: drop the shell `ws`
 * kind and any token that is only whitespace, and trim each remaining token so
 * the significant character (`=`, `,`) shows without its surrounding spaces.
 */
const sig = (tokens: { kind: string; text: string }[]) =>
  tokens
    .filter((t) => t.kind !== "ws" && t.text.trim() !== "")
    .map((t) => `${t.kind}:${t.text.trim()}`);

/** Rebuild the original string from tokens — the invariant that layout is exact. */
const rebuild = (tokens: { text: string }[]) => tokens.map((t) => t.text).join("");

describe("tokenizeShell", () => {
  it("colors a delete command red and its path yellow (the screenshot case)", () => {
    const tokens = tokenizeShell("rm 'Ikemenogo.Co (2025).zip'");
    expect(sig(tokens)).toEqual(["danger:rm", "path:'Ikemenogo.Co (2025).zip'"]);
    expect(rebuild(tokens)).toBe("rm 'Ikemenogo.Co (2025).zip'");
  });

  it("colors a regular command blue, flags/body white, paths yellow", () => {
    const tokens = tokenizeShell("ls -la src/main.ts");
    expect(sig(tokens)).toEqual(["cmd:ls", "flag:-la", "path:src/main.ts"]);
  });

  it("treats each chained segment's verb as a command", () => {
    const tokens = tokenizeShell("git add -A && rm build.zip");
    expect(sig(tokens)).toEqual([
      "cmd:git",
      "text:add", // subcommand slot, not destructive → body white
      "flag:-A",
      "op:&&",
      "danger:rm",
      "path:build.zip",
    ]);
  });

  it("flags a destructive subcommand after a wrapper as red", () => {
    expect(sig(tokenizeShell("git rm old.txt"))).toEqual([
      "cmd:git",
      "danger:rm",
      "path:old.txt",
    ]);
    expect(sig(tokenizeShell("npm uninstall lodash"))).toEqual([
      "cmd:npm",
      "danger:uninstall",
      "text:lodash",
    ]);
  });

  it("recognizes absolute, home, and dotted relative paths", () => {
    expect(sig(tokenizeShell("cat /etc/hosts ~/notes ./a.js")))
      .toEqual(["cmd:cat", "path:/etc/hosts", "path:~/notes", "path:./a.js"]);
  });

  it("preserves whitespace exactly", () => {
    const original = "  echo   hello   world  ";
    expect(rebuild(tokenizeShell(original))).toBe(original);
  });
});

describe("isCommandLine (colorize only real command lines inside output)", () => {
  it("recognizes the command lines echoed in run output", () => {
    // The exact first lines from the screenshots' OUTPUT blocks.
    expect(isCommandLine("ls -la '/Users/kellyikemenogo/Documents/Websites/Example Portfolio Website'")).toBe(true);
    expect(isCommandLine("rm '/Users/kellyikemenogo/Documents/Websites/Example Portfolio Website/Ikemenogo.Co (2025).zip'")).toBe(true);
  });

  it("leaves directory-listing and stdout lines neutral", () => {
    expect(isCommandLine("total 3352")).toBe(false);
    expect(isCommandLine("drwxr-xr-x 26 kellyikemenogo staff 832 Jul 15 22:17 .")).toBe(false);
    expect(isCommandLine("-rw-r--r-- 1 kellyikemenogo staff 12292 Jul 15 22:19 .DS_Store")).toBe(false);
    expect(isCommandLine("(no output)")).toBe(false);
    expect(isCommandLine("[exit 0]")).toBe(false);
    expect(isCommandLine("")).toBe(false);
  });
});

describe("tokenizeCode", () => {
  it("colors keywords, function calls, strings, and numbers", () => {
    expect(sig(tokenizeCode('const x = foo("hi", 42)'))).toEqual([
      "keyword:const",
      "text:x",
      "text:=", // operator run stays plain
      "fn:foo",
      "text:(",
      'str:"hi"',
      "text:,",
      "num:42",
      "text:)",
    ]);
  });

  it("colors line and block comments", () => {
    expect(sig(tokenizeCode("a // trailing"))).toContain("comment:// trailing");
    expect(sig(tokenizeCode("/* block */ b"))).toContain("comment:/* block */");
  });

  it("colors HTML tag names and quoted attribute values", () => {
    const tokens = tokenizeCode('<footer class="bg-black">');
    const s = sig(tokens);
    expect(s).toContain("fn:footer");
    expect(s).toContain('str:"bg-black"');
    expect(rebuild(tokens)).toBe('<footer class="bg-black">');
  });

  it("colors an HTML comment as a comment", () => {
    expect(sig(tokenizeCode("<!-- Footer -->"))).toEqual(["comment:<!-- Footer -->"]);
  });

  it("never loses characters — round-trips arbitrary code", () => {
    const src = 'function greet(n) {\n  return `hi ${n}`; // wave\n}';
    expect(rebuild(tokenizeCode(src))).toBe(src);
  });
});
