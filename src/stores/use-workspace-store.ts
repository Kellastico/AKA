import { create } from "zustand";

export type PaneType =
  | "output"
  | "diff"
  | "files"
  | "console"
  | "browser"
  | "history";
export type PaneSide = "left" | "right";

export type ExtraPane = {
  id: string;
  type: PaneType;
  side: PaneSide;
  /**
   * For "files" panes: the file open in the tree's right-hand column, or
   * undefined for the empty state. For "diff" panes: the diffed file.
   */
  filePath?: string;
  /** Set for "browser" panes — the URL currently loaded in the iframe. */
  url?: string;
};

const PANE_LIMIT = 2;

/** Build an equal-split ratio array: every pane gets 1, so widths are 1/N each. */
const equalRatios = (n: number) => Array(n).fill(1);

/** Visual order: left panes (in insertion order), then chat, then right panes. */
export const orderedPanes = (extras: ExtraPane[]) => [
  ...extras.filter((p) => p.side === "left"),
  ...extras.filter((p) => p.side === "right"),
];
/** Index of the chat slot in the [...left, chat, ...right] visual array. */
export const chatVisualIndex = (extras: ExtraPane[]) =>
  extras.filter((p) => p.side === "left").length;

/**
 * Pane types that can take over the whole workspace. Deliberately narrow: the
 * two panes people actually want edge-to-edge are the rendered preview and the
 * filetree. Widening this set is the only change needed to offer it elsewhere.
 */
const EXPANDABLE_TYPES: PaneType[] = ["browser", "files"];

export const isExpandableType = (type: PaneType) =>
  EXPANDABLE_TYPES.includes(type);

/**
 * Drop `expandedPaneId` when the pane it points at has gone away or has
 * changed into a type that can't be expanded (reusing a pane for a diff, say).
 * Without this the workspace would keep rendering an overlay for a pane that
 * no longer offers a way out of it.
 */
const guardExpanded = (
  extras: ExtraPane[],
  expandedPaneId: string | null,
): string | null => {
  if (!expandedPaneId) return null;
  const pane = extras.find((p) => p.id === expandedPaneId);
  return pane && isExpandableType(pane.type) ? expandedPaneId : null;
};

type WorkspaceState = {
  extraPanes: ExtraPane[];
  /** Flex ratios aligned with the visual order [...left, chat, ...right]. Length === 1 + extraPanes.length. */
  paneRatios: number[];
  /** True while the user is actively dragging a resizer — disables layout transitions. */
  dragging: boolean;
  /** id of focused extra pane, or null when chat is focused. */
  activePaneId: string | null;
  /**
   * id of the pane currently taking over the whole workspace, or null when the
   * panes are laid out side by side. The expanded pane stays mounted in its
   * normal slot and is merely repositioned, so a Preview iframe keeps its page
   * (and scroll position) across expand/collapse instead of reloading.
   */
  expandedPaneId: string | null;
  /**
   * Monotonically-increasing tick that browser panes watch to know they
   * should reload. Anything that mutates the project on disk (a finished
   * agent run, a verify command, a manual file save) can call
   * `bumpPreviewReload()` to roll the visible preview forward without the
   * user having to hit the refresh button.
   */
  previewReloadCounter: number;
  bumpPreviewReload: () => void;
  /** Open a pane from the top-right "+" menu — always docks on the right side of chat. */
  openPane: (type: PaneType) => void;
  /**
   * Open a diff pane targeting a specific file. Triggered by clicking a tool/diff chip
   * in chat — always docks on the RIGHT side of chat. Reuses an existing diff pane if
   * one is open (moving it right and updating its file).
   */
  openDiffForFile: (path: string) => void;
  closePane: (id: string) => void;
  clearPanes: () => void;
  setPaneRatios: (ratios: number[]) => void;
  setDragging: (dragging: boolean) => void;
  setActivePane: (id: string | null) => void;
  /**
   * Open a file in the filetree pane's right-hand column — the single route
   * for viewing a file, whether the click came from the tree itself or from a
   * path chip in the conversation. Surfaces the pane if it isn't open.
   */
  openFileInFiletree: (path: string) => void;
  /** Clear the file open in a filetree pane, back to its empty state. */
  closeFiletreeFile: (id: string) => void;
  /** Update the URL loaded in a browser pane. No-op if the id is not a browser pane. */
  updatePaneUrl: (id: string, url: string) => void;
  /** Expand a pane to fill the workspace, or collapse it if it already does. */
  togglePaneExpanded: (id: string) => void;
  /** Return to the side-by-side layout. Safe to call when nothing is expanded. */
  collapseExpandedPane: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  extraPanes: [],
  paneRatios: equalRatios(1),
  dragging: false,
  activePaneId: null,
  expandedPaneId: null,
  previewReloadCounter: 0,
  bumpPreviewReload: () =>
    set((s) => ({ previewReloadCounter: s.previewReloadCounter + 1 })),
  openPane: (type) => {
    const current = get().extraPanes;
    if (current.length >= PANE_LIMIT) return;
    // Each pane type may only appear once — focus the existing one instead of
    // opening a duplicate.
    const existing = current.find((p) => p.type === type);
    if (existing) {
      set({ activePaneId: existing.id });
      return;
    }
    const id = `${type}-${Date.now()}`;
    const newPanes = [...current, { id, type, side: "right" as PaneSide }];
    set({
      extraPanes: newPanes,
      paneRatios: equalRatios(1 + newPanes.length),
      activePaneId: id,
    });
  },
  openDiffForFile: (path) => {
    const current = get().extraPanes;
    const existing = current.find((p) => p.type === "diff");
    if (existing) {
      const nextPanes = current.map((p) =>
        p.id === existing.id
          ? { ...p, side: "right" as PaneSide, filePath: path }
          : p,
      );
      set({
        extraPanes: nextPanes,
        activePaneId: existing.id,
        expandedPaneId: guardExpanded(nextPanes, get().expandedPaneId),
      });
      return;
    }
    if (current.length >= PANE_LIMIT) return;
    const id = `diff-${Date.now()}`;
    const newPanes: ExtraPane[] = [
      ...current,
      { id, type: "diff", side: "right", filePath: path },
    ];
    set({
      extraPanes: newPanes,
      paneRatios: equalRatios(1 + newPanes.length),
      activePaneId: id,
    });
  },
  closePane: (id) => {
    const idx = get().extraPanes.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const newExtras = [...get().extraPanes];
    newExtras.splice(idx, 1);
    const wasActive = get().activePaneId === id;
    set({
      extraPanes: newExtras,
      paneRatios: equalRatios(1 + newExtras.length),
      activePaneId: wasActive ? null : get().activePaneId,
      expandedPaneId: guardExpanded(newExtras, get().expandedPaneId),
    });
  },
  clearPanes: () =>
    set({
      extraPanes: [],
      paneRatios: equalRatios(1),
      activePaneId: null,
      expandedPaneId: null,
    }),
  setPaneRatios: (paneRatios) => set({ paneRatios }),
  setDragging: (dragging) => set({ dragging }),
  setActivePane: (activePaneId) => set({ activePaneId }),
  updatePaneUrl: (id, url) =>
    set({
      extraPanes: get().extraPanes.map((p) =>
        p.id === id && p.type === "browser" ? { ...p, url } : p
      ),
    }),
  closeFiletreeFile: (id) =>
    set({
      extraPanes: get().extraPanes.map((p) =>
        p.id === id && p.type === "files" ? { ...p, filePath: undefined } : p,
      ),
    }),
  openFileInFiletree: (path) => {
    const { extraPanes, activePaneId } = get();

    const existing = extraPanes.find((p) => p.type === "files");
    if (existing) {
      set({
        extraPanes: extraPanes.map((p) =>
          p.id === existing.id ? { ...p, filePath: path } : p,
        ),
        activePaneId: existing.id,
      });
      return;
    }

    if (extraPanes.length < PANE_LIMIT) {
      const id = `files-${Date.now()}`;
      const newPanes: ExtraPane[] = [
        ...extraPanes,
        { id, type: "files", side: "right", filePath: path },
      ];
      set({
        extraPanes: newPanes,
        paneRatios: equalRatios(1 + newPanes.length),
        activePaneId: id,
      });
      return;
    }

    // Both slots are taken. Take over the focused pane rather than dropping
    // the request — a file open should never silently do nothing.
    const targetId =
      (activePaneId && extraPanes.find((p) => p.id === activePaneId)?.id) ??
      extraPanes[0].id;
    const nextPanes = extraPanes.map((p) =>
      p.id === targetId
        ? { ...p, type: "files" as PaneType, filePath: path, url: undefined }
        : p,
    );
    set({
      extraPanes: nextPanes,
      activePaneId: targetId,
      expandedPaneId: guardExpanded(nextPanes, get().expandedPaneId),
    });
  },
  togglePaneExpanded: (id) => {
    const pane = get().extraPanes.find((p) => p.id === id);
    if (!pane || !isExpandableType(pane.type)) return;
    set({
      expandedPaneId: get().expandedPaneId === id ? null : id,
      // Expanding is also a focus gesture — the pane you blew up is the one
      // you are working in, so the header's active ring should follow it.
      activePaneId: id,
    });
  },
  collapseExpandedPane: () => set({ expandedPaneId: null }),
}));

export const PANE_LABELS: Record<PaneType, string> = {
  output: "Output",
  diff: "Diff",
  files: "Filetree",
  console: "Terminal",
  browser: "Preview",
  history: "History",
};
