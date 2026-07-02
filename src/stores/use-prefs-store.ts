import { create } from "zustand";
import { load } from "@tauri-apps/plugin-store";

/**
 * Small bag of user-level UI preferences that persist across launches — the
 * "don't show this again" style toggles. Backed by tauri-plugin-store
 * (`aka-prefs.json`), the same pattern as the other persisted stores. No
 * localStorage (project rule).
 */

const STORE_FILE = "aka-prefs.json";
const KEY_SUPPRESS_SAME_MODEL_ADVICE = "suppressSameModelAdvice";
const KEY_SUPPRESS_DELETE_PROJECT_WARNING = "suppressDeleteProjectWarning";
const KEY_AUTO_APPLY_POSTURE = "autoApplyPosture";

type PrefsState = {
  /** When true, the "reuse your current model" tip is never shown again. */
  suppressSameModelAdvice: boolean;
  /** When true, the full-screen "delete project" warning is skipped. */
  suppressDeleteProjectWarning: boolean;
  /**
   * Opt-in: when true, switching models auto-selects that model's recommended
   * posture for the session. Default false so the recommendation stays advisory
   * — nothing is auto-changed unless the user turns this on (Task 2 acceptance).
   */
  autoApplyPosture: boolean;
  initialized: boolean;
  /** Restore prefs from disk on app start. */
  init: () => Promise<void>;
  setSuppressSameModelAdvice: (value: boolean) => Promise<void>;
  setSuppressDeleteProjectWarning: (value: boolean) => Promise<void>;
  setAutoApplyPosture: (value: boolean) => Promise<void>;
};

export const usePrefsStore = create<PrefsState>((set, get) => ({
  suppressSameModelAdvice: false,
  suppressDeleteProjectWarning: false,
  autoApplyPosture: false,
  initialized: false,

  init: async () => {
    if (get().initialized) return;
    try {
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      const v = await store.get<boolean>(KEY_SUPPRESS_SAME_MODEL_ADVICE);
      const d = await store.get<boolean>(KEY_SUPPRESS_DELETE_PROJECT_WARNING);
      const p = await store.get<boolean>(KEY_AUTO_APPLY_POSTURE);
      set({
        suppressSameModelAdvice: v === true,
        suppressDeleteProjectWarning: d === true,
        autoApplyPosture: p === true,
        initialized: true,
      });
    } catch {
      // Outside Tauri (browser dev) — defaults, in-memory only.
      set({ initialized: true });
    }
  },

  setSuppressSameModelAdvice: async (value) => {
    set({ suppressSameModelAdvice: value });
    try {
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      await store.set(KEY_SUPPRESS_SAME_MODEL_ADVICE, value);
      await store.save();
    } catch {
      // Outside Tauri — in-memory only.
    }
  },

  setSuppressDeleteProjectWarning: async (value) => {
    set({ suppressDeleteProjectWarning: value });
    try {
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      await store.set(KEY_SUPPRESS_DELETE_PROJECT_WARNING, value);
      await store.save();
    } catch {
      // Outside Tauri — in-memory only.
    }
  },

  setAutoApplyPosture: async (value) => {
    set({ autoApplyPosture: value });
    try {
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      await store.set(KEY_AUTO_APPLY_POSTURE, value);
      await store.save();
    } catch {
      // Outside Tauri — in-memory only.
    }
  },
}));
