import { RefObject, useEffect } from "react";

export function useDismiss(
  open: boolean,
  onClose: () => void,
  ignoreRefs: RefObject<HTMLElement | null>[]
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      for (const ref of ignoreRefs) {
        if (ref.current?.contains(target)) return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Clicking into the Preview <iframe> (or leaving the app) steals focus
    // without firing a parent-document mousedown — close on window blur too so
    // "click outside to close" still works over the iframe.
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);
}
