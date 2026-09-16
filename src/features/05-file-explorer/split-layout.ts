/**
 * Below this pane width the split stops paying for itself — a tree and a file
 * sharing ~440px leaves neither readable — so the pane falls back to a single
 * column and swaps the tree out for the open file.
 */
export const SPLIT_MIN_WIDTH = 560;

export type SplitLayout = {
  /** True when there is room for both columns at once. */
  wide: boolean;
  showTree: boolean;
  showViewer: boolean;
  showDivider: boolean;
  /** Whether the viewer needs a back control to reach the tree again. */
  showBack: boolean;
};

/**
 * Decide which of the filetree pane's two columns are on screen.
 *
 * Wide always shows both — the right side carries an empty state when no file
 * is open. Narrow shows exactly one: the tree until you pick a file, then the
 * file with a way back.
 */
export function splitLayout(width: number, hasFile: boolean): SplitLayout {
  const wide = width >= SPLIT_MIN_WIDTH;
  return {
    wide,
    showTree: wide || !hasFile,
    showViewer: wide || hasFile,
    showDivider: wide,
    showBack: !wide && hasFile,
  };
}
