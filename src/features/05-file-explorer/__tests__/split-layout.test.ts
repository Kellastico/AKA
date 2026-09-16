import { describe, expect, it } from "vitest";
import { SPLIT_MIN_WIDTH, splitLayout } from "../split-layout";

const WIDE = SPLIT_MIN_WIDTH + 200;
const NARROW = SPLIT_MIN_WIDTH - 120;

describe("splitLayout", () => {
  it("shows both columns when wide, with or without a file", () => {
    for (const hasFile of [true, false]) {
      const l = splitLayout(WIDE, hasFile);
      expect(l).toMatchObject({
        wide: true,
        showTree: true,
        showViewer: true,
        showDivider: true,
      });
    }
  });

  it("never offers a back control while both columns are visible", () => {
    expect(splitLayout(WIDE, true).showBack).toBe(false);
    expect(splitLayout(WIDE, false).showBack).toBe(false);
  });

  it("shows the tree alone when narrow with no file open", () => {
    expect(splitLayout(NARROW, false)).toEqual({
      wide: false,
      showTree: true,
      showViewer: false,
      showDivider: false,
      showBack: false,
    });
  });

  it("swaps the tree for the file, with a way back, when narrow", () => {
    expect(splitLayout(NARROW, true)).toEqual({
      wide: false,
      showTree: false,
      showViewer: true,
      showDivider: false,
      showBack: true,
    });
  });

  it("always leaves exactly one column visible when narrow", () => {
    for (const hasFile of [true, false]) {
      const l = splitLayout(NARROW, hasFile);
      expect([l.showTree, l.showViewer].filter(Boolean)).toHaveLength(1);
    }
  });

  it("never hides both columns at any width", () => {
    for (const w of [0, 1, 200, NARROW, SPLIT_MIN_WIDTH, WIDE, 4000]) {
      for (const hasFile of [true, false]) {
        const l = splitLayout(w, hasFile);
        expect(l.showTree || l.showViewer).toBe(true);
      }
    }
  });

  it("treats the threshold itself as wide", () => {
    expect(splitLayout(SPLIT_MIN_WIDTH, false).wide).toBe(true);
    expect(splitLayout(SPLIT_MIN_WIDTH - 1, false).wide).toBe(false);
  });

  it("only draws a divider when there are two columns to divide", () => {
    for (const w of [0, NARROW, WIDE]) {
      for (const hasFile of [true, false]) {
        const l = splitLayout(w, hasFile);
        if (l.showDivider) expect(l.showTree && l.showViewer).toBe(true);
      }
    }
  });

  it("an unmeasured pane (width 0) falls back to the tree", () => {
    expect(splitLayout(0, false).showTree).toBe(true);
  });
});
