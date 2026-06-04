import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";

/**
 * Drives the one-time first-run setup overlay. Persisted-flag pattern:
 * `completed` lives on disk so we never show the overlay twice; everything
 * else (currentStep, dismissed) is in-memory only.
 *
 * Heuristic for existing users: if `init()` finds the user already has
 * projects in their store, mark `completed=true` automatically. They've
 * clearly been around — no need to walk them through setup.
 */

export type FirstRunStep = "welcome" | "runtime" | "agent" | "project" | "done";

const STEPS: FirstRunStep[] = ["welcome", "runtime", "agent", "project", "done"];

const STORE_FILE = "aka-first-run.json";
const STORE_KEY = "completed";

type FirstRunState = {
  /** Persisted — true once the user finishes (or explicitly skips) setup. */
  completed: boolean;
  /** Local-only — which step the wizard is currently showing. */
  currentStep: FirstRunStep;
  /** Local-only — true while we're loading `completed` from disk. */
  loading: boolean;
  /**
   * Local-only — "skip for now". Hides the overlay for this session without
   * marking setup permanently complete, so it'll come back on next launch
   * if the user still hasn't done it.
   */
  dismissedThisSession: boolean;

  init: (hasExistingProjects: boolean) => Promise<void>;
  next: () => void;
  prev: () => void;
  goTo: (step: FirstRunStep) => void;
  complete: () => Promise<void>;
  dismiss: () => void;
  /** Re-open the wizard from scratch. Useful for testing / a settings menu. */
  reset: () => Promise<void>;
};

async function persistCompleted(value: boolean) {
  try {
    const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(STORE_KEY, value);
    await store.save();
  } catch {
    // Outside Tauri (browser dev) — in-memory only.
  }
}

export const useFirstRunStore = create<FirstRunState>((set, get) => ({
  completed: true, // Start true so the overlay never flashes pre-init.
  currentStep: "welcome",
  loading: true,
  dismissedThisSession: false,

  init: async (hasExistingProjects) => {
    try {
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      const saved = await store.get<boolean>(STORE_KEY);

      // If we've never persisted anything AND there are no projects, this is
      // a genuine first run — show the overlay. If there are projects, the
      // user has clearly used AKA before; mark completed so we don't pester.
      if (saved === undefined) {
        const isFirstRun = !hasExistingProjects;
        set({ completed: !isFirstRun, loading: false });
        if (!isFirstRun) await persistCompleted(true);
      } else {
        set({ completed: saved, loading: false });
      }
    } catch {
      // Outside Tauri — skip the overlay so dev preview works.
      set({ completed: true, loading: false });
    }
  },

  next: () => {
    const i = STEPS.indexOf(get().currentStep);
    if (i < STEPS.length - 1) set({ currentStep: STEPS[i + 1] });
  },
  prev: () => {
    const i = STEPS.indexOf(get().currentStep);
    if (i > 0) set({ currentStep: STEPS[i - 1] });
  },
  goTo: (step) => set({ currentStep: step }),

  complete: async () => {
    set({ completed: true, currentStep: "done" });
    await persistCompleted(true);
  },

  dismiss: () => set({ dismissedThisSession: true }),

  reset: async () => {
    set({
      completed: false,
      currentStep: "welcome",
      dismissedThisSession: false,
    });
    await persistCompleted(false);
  },
}));

export const FIRST_RUN_STEPS = STEPS;
