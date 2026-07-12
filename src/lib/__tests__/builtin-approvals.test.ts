import { describe, expect, it } from "vitest";
import {
  approvalGateFor,
  approvalPrompt,
  needsApproval,
  parseApprovalMode,
  parseToolArgs,
  stringArg,
} from "../builtin-approvals";

describe("approvalGateFor", () => {
  it("classifies the write tools as edit-gated", () => {
    expect(approvalGateFor("str_replace")).toBe("edit");
    expect(approvalGateFor("apply_diff")).toBe("edit");
    expect(approvalGateFor("delete_file")).toBe("edit");
  });

  it("classifies bash as exec-gated", () => {
    expect(approvalGateFor("bash")).toBe("exec");
  });

  it("never gates the read-only floor", () => {
    for (const t of ["read_file", "list_dir", "search_files", "diagnostics"]) {
      expect(approvalGateFor(t)).toBeNull();
    }
  });
});

describe("needsApproval", () => {
  it("ask mode pauses for both edits and exec", () => {
    expect(needsApproval("ask", "edit")).toBe(true);
    expect(needsApproval("ask", "exec")).toBe(true);
  });

  it("acceptEdits auto-approves edits but still asks for exec", () => {
    expect(needsApproval("acceptEdits", "edit")).toBe(false);
    expect(needsApproval("acceptEdits", "exec")).toBe(true);
  });

  it("auto mode never pauses", () => {
    expect(needsApproval("auto", "edit")).toBe(false);
    expect(needsApproval("auto", "exec")).toBe(false);
  });
});

describe("parseApprovalMode", () => {
  it("passes valid modes through and floors everything else to ask", () => {
    expect(parseApprovalMode("auto")).toBe("auto");
    expect(parseApprovalMode("acceptEdits")).toBe("acceptEdits");
    expect(parseApprovalMode("ask")).toBe("ask");
    expect(parseApprovalMode("bypass")).toBe("ask");
    expect(parseApprovalMode(undefined)).toBe("ask");
    expect(parseApprovalMode(null)).toBe("ask");
  });
});

describe("parseToolArgs / stringArg", () => {
  it("parses valid JSON and reads string fields", () => {
    const args = parseToolArgs(JSON.stringify({ path: "a.ts", n: 3 }));
    expect(stringArg(args, "path")).toBe("a.ts");
    expect(stringArg(args, "n")).toBe(""); // non-string → ""
    expect(stringArg(args, "missing")).toBe("");
  });

  it("returns {} for malformed JSON instead of throwing", () => {
    expect(parseToolArgs("not json")).toEqual({});
    expect(stringArg(parseToolArgs("not json"), "path")).toBe("");
  });
});

describe("approvalPrompt", () => {
  it("shows the exact command for bash", () => {
    expect(approvalPrompt("bash", { command: "npm test" })).toBe("Run: npm test");
  });

  it("shows the target file for edits and deletes", () => {
    expect(approvalPrompt("str_replace", { path: "src/a.ts" })).toBe(
      "Edit file: src/a.ts",
    );
    expect(approvalPrompt("delete_file", { path: "old.txt" })).toBe(
      "Delete file: old.txt",
    );
  });

  it("extracts the touched files from a unified diff", () => {
    const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    expect(approvalPrompt("apply_diff", { patch })).toBe("Apply patch to: src/x.ts");
  });

  it("names the real target of a deletion hunk (+++ /dev/null)", () => {
    const patch = "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
    expect(approvalPrompt("apply_diff", { patch })).toBe("Apply patch to: old.txt");
  });

  it("degrades gracefully on malformed / unknown args", () => {
    expect(approvalPrompt("bash", parseToolArgs("not json"))).toBe(
      "Run: (empty command)",
    );
    expect(approvalPrompt("mystery_tool", {})).toBe("Run tool: mystery_tool");
  });
});
