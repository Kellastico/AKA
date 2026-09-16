import { create } from "zustand";

/**
 * Fraction of the pane's width given to the tree column. Widened from 0.34
 * when the tree text went up to 13px and the search box to 36px/14px — at the
 * old default the search box truncated its own placeholder before you had
 * typed anything.
 */
const DEFAULT_TREE_RATIO = 0.4;
export const MIN_TREE_RATIO = 0.18;
export const MAX_TREE_RATIO = 0.7;

/**
 * Cross-component state for the filetree pane. The pane owns its query,
 * selection and dir cache as local state; what lives here is the split ratio,
 * so dragging the divider is remembered for the session rather than snapping
 * back whenever the pane re-renders.
 */
type FiletreeState = {
  /** Width of the tree column as a fraction of the pane, clamped on write. */
  treeRatio: number;
  setTreeRatio: (ratio: number) => void;
};

export const useFiletreeStore = create<FiletreeState>((set) => ({
  treeRatio: DEFAULT_TREE_RATIO,
  setTreeRatio: (ratio) =>
    set({
      treeRatio: Math.min(MAX_TREE_RATIO, Math.max(MIN_TREE_RATIO, ratio)),
    }),
}));
