import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { watchDir, unwatchDir } from "./tauri/commands";

/**
 * Subscribe to live changes anywhere under a project directory.
 *
 * The backend `watch_dir` command runs ONE polling task per path and emits
 * `project://changed` on any create/edit/delete (self-churning dirs like
 * `node_modules`/`.git` are skipped backend-side). Several panes (Files,
 * Preview) may watch the same project at once, so the backend watcher is
 * **reference-counted here**: the first subscriber starts it, the last one to
 * leave tears it down. Without this, whichever pane unmounted first would
 * `unwatch_dir` and silently kill the other pane's live updates.
 *
 * `onChange` fires (debounced) when something under `path` changes. Pass
 * `path = null` to disable (e.g. Preview only watches while a URL is loaded).
 * The callback is read through a ref, so it never needs to be memoized by the
 * caller and never re-subscribes the watcher.
 */
const watcherCounts = new Map<string, number>();

export function useProjectWatch(
  path: string | null,
  onChange: () => void,
  debounceMs = 300,
) {
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!path) return;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const next = (watcherCounts.get(path) ?? 0) + 1;
    watcherCounts.set(path, next);
    if (next === 1) void watchDir(path);

    void listen<{ path?: string }>("project://changed", (e) => {
      // Only react to this path's watcher (other projects emit their own).
      if (e.payload?.path && e.payload.path !== path) return;
      // Collapse a burst of writes (an agent touching many files) into one.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => cb.current(), debounceMs);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      unlisten?.();
      const left = (watcherCounts.get(path) ?? 1) - 1;
      if (left <= 0) {
        watcherCounts.delete(path);
        void unwatchDir(path);
      } else {
        watcherCounts.set(path, left);
      }
    };
  }, [path, debounceMs]);
}
