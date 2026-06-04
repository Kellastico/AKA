import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  readTextFile,
  watchFile,
  writeTextFile,
  unwatchFile,
  type FilePayload,
} from "./tauri/commands";

export type FileBufferStatus =
  | "loading"
  | "ready"
  | "saving"
  | "error";

/**
 * Live-edit buffer for a single file on disk.
 *
 * - `value` is the in-memory editor state.
 * - `dirty` is true when the user has typed since the last save/load.
 * - `conflict` carries the on-disk version when something external (the agent,
 *   another editor, etc.) wrote the file while the user had unsaved changes.
 *   The component decides whether to reload, keep, or show a diff.
 */
export function useFileBuffer(path: string | null | undefined) {
  const [value, setValue] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [mtime, setMtime] = useState<number>(0);
  const [status, setStatus] = useState<FileBufferStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<FilePayload | null>(null);

  // Track latest dirty + mtime in refs so the watcher callback (registered
  // once) always reads current values without re-subscribing.
  const dirtyRef = useRef(false);
  const valueRef = useRef("");
  const mtimeRef = useRef(0);
  const pathRef = useRef<string | null>(null);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    mtimeRef.current = mtime;
  }, [mtime]);
  useEffect(() => {
    dirtyRef.current = value !== original;
  }, [value, original]);

  // Load + watch when path changes.
  useEffect(() => {
    pathRef.current = path ?? null;
    if (!path) {
      setValue("");
      setOriginal("");
      setMtime(0);
      setStatus("ready");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setConflict(null);

    readTextFile(path)
      .then((f) => {
        if (cancelled || pathRef.current !== path) return;
        setValue(f.contents);
        setOriginal(f.contents);
        setMtime(f.mtimeMs);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setStatus("error");
      });

    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        await watchFile(path);
        unlisten = await listen<FilePayload>("file://changed", (e) => {
          if (e.payload.path !== pathRef.current) return;
          if (e.payload.mtimeMs <= mtimeRef.current) return;
          if (dirtyRef.current && e.payload.contents !== valueRef.current) {
            // User has unsaved edits AND on-disk content differs from the
            // buffer — surface a conflict; component decides how to resolve.
            setConflict(e.payload);
          } else {
            // No local changes, or on-disk now matches the buffer — adopt.
            setValue(e.payload.contents);
            setOriginal(e.payload.contents);
            setMtime(e.payload.mtimeMs);
            setConflict(null);
          }
        });
      } catch {
        // Watching is best-effort. Read still works without it.
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (path) void unwatchFile(path);
    };
  }, [path]);

  const save = useCallback(async () => {
    if (!path) return;
    setStatus("saving");
    setError(null);
    try {
      const newMtime = await writeTextFile(path, valueRef.current);
      setOriginal(valueRef.current);
      setMtime(newMtime);
      setConflict(null);
      setStatus("ready");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }, [path]);

  const reloadFromDisk = useCallback(() => {
    if (!conflict) return;
    setValue(conflict.contents);
    setOriginal(conflict.contents);
    setMtime(conflict.mtimeMs);
    setConflict(null);
  }, [conflict]);

  const dismissConflict = useCallback(() => {
    // Keep the user's edits in `value`. Adopt the new mtime so the next watch
    // tick doesn't keep re-flagging the same disk version.
    if (!conflict) return;
    setMtime(conflict.mtimeMs);
    setConflict(null);
  }, [conflict]);

  return {
    value,
    setValue,
    original,
    dirty: value !== original,
    status,
    error,
    conflict,
    save,
    reloadFromDisk,
    dismissConflict,
  };
}
