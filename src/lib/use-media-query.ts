import { useSyncExternalStore } from "react";

/**
 * Subscribe to a CSS media query. Used for JS-driven responsive behavior that
 * pure Tailwind classes can't express — e.g. the top bar's Plugins pill
 * dropping to icon-only (and gaining a hover tooltip) on narrow windows.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}
