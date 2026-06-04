import { create } from "zustand";

/**
 * Tracks what would happen if the user dropped the files they're currently
 * dragging. Updated on dragenter so the overlay is visible before the drop
 * lands, not after.
 */
type DragStoreState = {
  /** Whether a drag is active over the window. */
  active: boolean;
  /** Files / folders that will be attached on drop. */
  acceptedCount: number;
  /** Images that will be blocked because the model isn't vision-capable. */
  rejectedCount: number;

  setDrag: (opts: { acceptedCount: number; rejectedCount: number }) => void;
  clear: () => void;
};

export const useDragStore = create<DragStoreState>((set) => ({
  active: false,
  acceptedCount: 0,
  rejectedCount: 0,
  setDrag: ({ acceptedCount, rejectedCount }) =>
    set({ active: true, acceptedCount, rejectedCount }),
  clear: () => set({ active: false, acceptedCount: 0, rejectedCount: 0 }),
}));
