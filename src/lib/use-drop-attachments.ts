import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  inferKindFromPath,
  useAttachmentsStore,
} from "../stores/use-attachments-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";
import { useDragStore } from "../stores/use-drag-store";
import { isMultimodalModel } from "./model-capabilities";

const hasTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * Global drag-and-drop intake. Shows a live overlay on the chatbox the moment
 * a drag enters the window (before the drop) so users know what will happen:
 *   - files / folders  → always accepted (violet)
 *   - images + vision model → accepted (violet)
 *   - images + text model  → rejected (red)
 *
 * On drop, commits accepted items to the attachment store and fires a toast
 * for anything that was blocked.
 */
export function useDropAttachments() {
  useEffect(() => {
    if (!hasTauri()) {
      return browserFallback();
    }
    return tauriFallback();
  }, []);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Classify a list of file paths against the current model and write the result
 * to the drag store so the overlay can show the right state immediately.
 */
function classifyPaths(paths: string[]) {
  if (paths.length === 0) return;
  const modelId = useRuntimeStore.getState().selectedModelId;
  const multimodal = isMultimodalModel(modelId);
  let acceptedCount = 0;
  let rejectedCount = 0;

  for (const p of paths) {
    const kind = inferKindFromPath(p);
    if (kind === "image") {
      if (multimodal) acceptedCount++;
      else rejectedCount++;
    } else {
      acceptedCount++;
    }
  }

  useDragStore.getState().setDrag({ acceptedCount, rejectedCount });
}

/**
 * Commit accepted paths to the attachment store and clear the drag overlay.
 * Shows a blocking-toast if images were skipped due to missing vision support.
 */
function ingestPaths(paths: string[]) {
  if (paths.length === 0) {
    useDragStore.getState().clear();
    return;
  }
  const modelId = useRuntimeStore.getState().selectedModelId;
  const multimodal = isMultimodalModel(modelId);

  const files: string[] = [];
  const images: string[] = [];
  let blockedImages = 0;

  for (const p of paths) {
    const kind = inferKindFromPath(p);
    if (kind === "image") {
      if (multimodal) images.push(p);
      else blockedImages++;
    } else {
      files.push(p);
    }
  }

  const store = useAttachmentsStore.getState();
  if (files.length > 0) store.addPaths("file", files);
  if (images.length > 0) store.addPaths("image", images);

  if (blockedImages > 0) {
    useRuntimeStore.getState().pushToast({
      kind: "info",
      text:
        blockedImages === 1
          ? "Image skipped — current model isn't vision-capable. Switch to a multimodal model to attach images."
          : `${blockedImages} images skipped — current model isn't vision-capable.`,
    });
  }

  useDragStore.getState().clear();
}

// ── Tauri path ────────────────────────────────────────────────────────────────

function tauriFallback() {
  let unlisten: (() => void) | undefined;

  void getCurrentWebview()
    .onDragDropEvent((evt) => {
      const type = evt.payload.type;
      const payload = evt.payload as { paths?: string[] };

      if (type === "enter") {
        // Paths are available on "enter" — classify before the drop lands.
        classifyPaths(payload.paths ?? []);
      } else if (type === "leave") {
        useDragStore.getState().clear();
      } else if (type === "drop") {
        ingestPaths(payload.paths ?? []);
      }
      // "over" carries position only — nothing to do.
    })
    .then((fn) => {
      unlisten = fn;
    });

  return () => {
    unlisten?.();
    useDragStore.getState().clear();
  };
}

// ── Browser fallback ──────────────────────────────────────────────────────────

/**
 * Browser dev-mode fallback. `DataTransferItem.type` gives us the MIME type
 * before the drop, so we can classify images vs files on entry.
 *
 * Uses a reference counter to avoid spurious dragleave events that fire when
 * the pointer crosses child element boundaries.
 */
function browserFallback() {
  let counter = 0;

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    counter++;
    if (counter !== 1) return; // already tracking

    const modelId = useRuntimeStore.getState().selectedModelId;
    const multimodal = isMultimodalModel(modelId);
    let acceptedCount = 0;
    let rejectedCount = 0;

    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind !== "file") continue;
      const isImage = item.type.startsWith("image/");
      if (isImage) {
        if (multimodal) acceptedCount++;
        else rejectedCount++;
      } else {
        acceptedCount++;
      }
    }

    useDragStore.getState().setDrag({ acceptedCount, rejectedCount });
  };

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };

  const onDragLeave = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files") && counter === 0) return;
    counter = Math.max(0, counter - 1);
    if (counter === 0) useDragStore.getState().clear();
  };

  const onDrop = (e: DragEvent) => {
    counter = 0;
    if (!e.dataTransfer?.files.length) {
      useDragStore.getState().clear();
      return;
    }
    e.preventDefault();
    ingestPaths(Array.from(e.dataTransfer.files).map((f) => f.name));
  };

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);

  return () => {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
    useDragStore.getState().clear();
  };
}
