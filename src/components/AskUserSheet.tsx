import { useEffect, useMemo, useState } from "react";
import { Check, X } from "@phosphor-icons/react";
import { useAskUserStore } from "../stores/use-ask-user-store";

/**
 * Bottom-sheet question prompt. Slides up from the bottom of the screen —
 * the opposite direction of the searchbox dropdown ([[Omnibox]] / FileFinder
 * use `animate-slide-down-in`). Mounted once in [[AppShell]] and driven by
 * the promise-based API in [[use-ask-user-store]].
 */
export function AskUserSheet() {
  const current = useAskUserStore((s) => s.current);
  const resolve = useAskUserStore((s) => s.resolve);

  const [selected, setSelected] = useState<string[]>([]);

  // Reset selection whenever a new question opens. Pre-select the first
  // option for single-select so Enter immediately works.
  useEffect(() => {
    if (!current) {
      setSelected([]);
      return;
    }
    setSelected(current.multiSelect ? [] : [current.options[0]?.value].filter(Boolean) as string[]);
  }, [current]);

  // Esc dismisses (if allowed). Enter submits the current selection.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (current.dismissable ?? true)) {
        e.preventDefault();
        resolve([]);
      }
      if (e.key === "Enter" && selected.length > 0) {
        e.preventDefault();
        resolve(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, selected, resolve]);

  const optionStates = useMemo(() => {
    if (!current) return [];
    const set = new Set(selected);
    return current.options.map((o) => ({ ...o, picked: set.has(o.value) }));
  }, [current, selected]);

  if (!current) return null;

  const toggle = (value: string) => {
    if (current.multiSelect) {
      setSelected((prev) =>
        prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
      );
    } else {
      setSelected([value]);
    }
  };

  const dismissable = current.dismissable ?? true;
  const canSubmit = selected.length > 0;
  const confirmLabel = current.confirmLabel ?? "Continue";
  const cancelLabel = current.cancelLabel ?? "Cancel";

  return (
    <div
      data-testid="ask-user-sheet"
      className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => dismissable && resolve([])}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={current.question}
        onClick={(e) => e.stopPropagation()}
        className="animate-sheet-up-in w-full max-w-[640px] rounded-t-3xl border-t border-x border-white/12 bg-zinc-900/97 px-6 pb-7 pt-5 text-white shadow-[0_-20px_60px_rgba(0,0,0,0.6)]"
      >
        {/* Drag handle — purely decorative, signals "sheet" affordance. */}
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15" />

        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 className="text-base font-medium leading-snug text-white">
            {current.question}
          </h2>
          {dismissable && (
            <button
              onClick={() => resolve([])}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/40 hover:bg-white/10 hover:text-white/80"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {current.detail && (
          <p className="mb-4 text-sm text-white/55">{current.detail}</p>
        )}

        <div className="mb-5 mt-3 flex flex-col gap-1.5">
          {optionStates.map((o) => (
            <button
              key={o.value}
              onClick={() => toggle(o.value)}
              className={[
                "flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                o.picked
                  ? "border-emerald-400/40 bg-emerald-400/8"
                  : "border-white/8 bg-white/3 hover:border-white/15 hover:bg-white/6",
              ].join(" ")}
              aria-pressed={o.picked}
            >
              <span
                className={[
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                  o.picked
                    ? "border-emerald-300 bg-emerald-400 text-black"
                    : "border-white/25 bg-transparent",
                ].join(" ")}
              >
                {o.picked && <Check size={10} weight="bold" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-white/90">
                  {o.label}
                </span>
                {o.description && (
                  <span className="mt-0.5 block text-xs text-white/45">
                    {o.description}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          {dismissable && (
            <button
              onClick={() => resolve([])}
              className="rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs text-white/80 hover:bg-white/10"
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={() => canSubmit && resolve(selected)}
            disabled={!canSubmit}
            className="rounded-full bg-emerald-400/90 px-4 py-1.5 text-xs font-medium text-black hover:bg-emerald-300 disabled:opacity-40"
          >
            {confirmLabel}
            {current.multiSelect && selected.length > 0 && (
              <span className="ml-1.5 text-black/65">· {selected.length}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
