import { create } from "zustand";

export type PaneType = "output" | "diff" | "files" | "console" | "file" | "browser";
export type PaneSide = "left" | "right";

export type ExtraPane = {
  id: string;
  type: PaneType;
  side: PaneSide;
  /** Set for "file" panes (omnibox-routed path) and "diff" panes (the diffed file). */
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

type WorkspaceState = {
  extraPanes: ExtraPane[];
  /** Flex ratios aligned with the visual order [...left, chat, ...right]. Length === 1 + extraPanes.length. */
  paneRatios: number[];
  /** True while the user is actively dragging a resizer — disables layout transitions. */
  dragging: boolean;
  /** id of focused extra pane, or null when chat is focused. */
  activePaneId: string | null;
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
   * Route a path to the active pane.
   * - Active extra pane → convert it to a file pane at `path`.
   * - Chat focused + no extras → spawn a file pane (right side).
   * - Chat focused + extras exist → target the first extra pane.
   */
  openFileInActivePane: (path: string) => void;
  /** Update the URL loaded in a browser pane. No-op if the id is not a browser pane. */
  updatePaneUrl: (id: string, url: string) => void;
  /** Flip a "file" / "diff" pane back to the files tree listing. */
  showFilesInPane: (id: string) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  extraPanes: [],
  paneRatios: equalRatios(1),
  dragging: false,
  activePaneId: null,
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
      set({
        extraPanes: current.map((p) =>
          p.id === existing.id ? { ...p, side: "right", filePath: path } : p
        ),
        activePaneId: existing.id,
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
    });
  },
  clearPanes: () =>
    set({ extraPanes: [], paneRatios: equalRatios(1), activePaneId: null }),
  setPaneRatios: (paneRatios) => set({ paneRatios }),
  setDragging: (dragging) => set({ dragging }),
  setActivePane: (activePaneId) => set({ activePaneId }),
  updatePaneUrl: (id, url) =>
    set({
      extraPanes: get().extraPanes.map((p) =>
        p.id === id && p.type === "browser" ? { ...p, url } : p
      ),
    }),
  showFilesInPane: (id) =>
    set({
      extraPanes: get().extraPanes.map((p) =>
        p.id === id
          ? { ...p, type: "files", filePath: undefined, url: undefined }
          : p,
      ),
      activePaneId: id,
    }),
  openFileInActivePane: (path) => {
    const { extraPanes, activePaneId } = get();
    const targetId =
      (activePaneId && extraPanes.find((p) => p.id === activePaneId)?.id) ??
      extraPanes[0]?.id ??
      null;

    if (targetId) {
      set({
        extraPanes: extraPanes.map((p) =>
          p.id === targetId ? { ...p, type: "file", filePath: path } : p
        ),
        activePaneId: targetId,
      });
      return;
    }

    if (extraPanes.length >= PANE_LIMIT) return;
    const id = `file-${Date.now()}`;
    const newPanes: ExtraPane[] = [
      ...extraPanes,
      { id, type: "file", side: "right", filePath: path },
    ];
    set({
      extraPanes: newPanes,
      paneRatios: equalRatios(1 + newPanes.length),
      activePaneId: id,
    });
  },
}));

export const PANE_LABELS: Record<PaneType, string> = {
  output: "Output",
  diff: "Diff",
  files: "Files",
  console: "Terminal",
  file: "File",
  browser: "Preview",
};
