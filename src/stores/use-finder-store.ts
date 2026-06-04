import { create } from "zustand";

type FinderState = {
  open: boolean;
  openFinder: () => void;
  closeFinder: () => void;
};

export const useFinderStore = create<FinderState>((set) => ({
  open: false,
  openFinder: () => set({ open: true }),
  closeFinder: () => set({ open: false }),
}));
