import { describe, it, expect } from "vitest";
import { stripAnsi } from "../noise";

describe("stripAnsi", () => {
  it("strips proper ANSI SGR sequences (ESC [ … m)", () => {
    expect(stripAnsi("\x1b[31mhi\x1b[0m")).toBe("hi");
  });

  it("strips the malformed replacement-char forms (�/◇/□ + [ … m)", () => {
    expect(stripAnsi("�[1mhi�[0m")).toBe("hi");
    expect(stripAnsi("◇[1mhi◇[0m")).toBe("hi");
    expect(stripAnsi("□[1mhi□[0m")).toBe("hi");
  });

  it("leaves bare [<digits>m inside legitimate prose/code untouched", () => {
    // Regression: the optional-prefix form corrupted these to `arr]`, ``, `value`.
    expect(stripAnsi("arr[0m]")).toBe("arr[0m]");
    expect(stripAnsi("[3m")).toBe("[3m");
    expect(stripAnsi("value[10m")).toBe("value[10m");
  });

  it("strips real sequences while preserving an adjacent bare bracket form", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m arr[0m]")).toBe("ok arr[0m]");
  });
});
