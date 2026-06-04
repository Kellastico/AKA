import { create } from "zustand";

/**
 * One option in an askUser prompt. `value` is what the resolved promise
 * receives; `label` is what the user sees; `description` is the optional
 * help-text under the label.
 */
export type AskOption = {
  value: string;
  label: string;
  description?: string;
};

export type AskRequest = {
  /** The headline question. Plain string — keep it under ~80 chars. */
  question: string;
  /** Optional preamble shown above the options list. */
  detail?: string;
  /** 2–6 options. Single-select unless `multiSelect` is true. */
  options: AskOption[];
  /** Allow multiple selections. Default false. */
  multiSelect?: boolean;
  /** Label for the confirm button. Default: "Continue". */
  confirmLabel?: string;
  /** Label for the cancel/dismiss button. Default: "Cancel". */
  cancelLabel?: string;
  /** Allow dismiss without picking anything. Default true. */
  dismissable?: boolean;
};

type PendingRequest = AskRequest & {
  resolve: (answers: string[]) => void;
};

type AskUserState = {
  current: PendingRequest | null;
  /**
   * Open a question sheet. Resolves with the chosen value(s) on submit, or
   * an empty array if the user dismisses. Calling while another request is
   * open queues the new one — the next sheet opens once the current closes.
   *
   * @example
   * const [picked] = await askUser({
   *   question: "Which runtime do you want to connect to?",
   *   options: [
   *     { value: "ollama",  label: "Ollama",   description: "localhost:11434" },
   *     { value: "lmstudio",label: "LM Studio",description: "localhost:1234"  },
   *     { value: "mlx",     label: "MLX",      description: "localhost:8080"  },
   *   ],
   * });
   */
  askUser: (req: AskRequest) => Promise<string[]>;
  /** Internal — called by the sheet when the user picks/dismisses. */
  resolve: (answers: string[]) => void;
};

const queue: PendingRequest[] = [];

const drain = (set: (s: Partial<AskUserState>) => void) => {
  const next = queue.shift() ?? null;
  set({ current: next });
};

export const useAskUserStore = create<AskUserState>((set, get) => ({
  current: null,
  askUser: (req) =>
    new Promise<string[]>((resolve) => {
      const entry: PendingRequest = { ...req, resolve };
      if (get().current) {
        queue.push(entry);
      } else {
        set({ current: entry });
      }
    }),
  resolve: (answers) => {
    const cur = get().current;
    if (!cur) return;
    cur.resolve(answers);
    drain(set);
  },
}));
