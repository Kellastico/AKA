import { create } from "zustand";

export type AttachmentKind = "file" | "folder" | "image" | "url";

export type Attachment = {
  id: string;
  kind: AttachmentKind;
  /** Display name — file/folder basename, image basename, or URL host. */
  name: string;
  /** Filesystem path. Set on file/folder/image attachments. */
  path?: string;
  /** Resolved URL. Set on url attachments. */
  url?: string;
  approxTokens: number;
};

// Rough per-kind token defaults. Real estimates would need to read the file
// (text length / 4) or call the runtime's tokenizer; we keep this constant for
// now since it only feeds the usage meter heuristic.
const DEFAULT_TOKENS: Record<AttachmentKind, number> = {
  file: 1200,
  folder: 4000,
  image: 1500,
  url: 800,
};

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "heic",
]);

/**
 * Infer attachment kind from a filesystem path. Used by drag-and-drop and
 * generic file picking to route the right path into the right bucket.
 */
export function inferKindFromPath(path: string): "file" | "image" {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTS.has(ext) ? "image" : "file";
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

function urlDisplay(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return raw;
  }
}

type AttachmentsState = {
  items: Attachment[];
  /** Attach one or more files / folders / images from real OS paths. */
  addPaths: (kind: "file" | "folder" | "image", paths: string[]) => void;
  /** Attach a single URL. Validates non-empty; display name is host+path. */
  addUrl: (rawUrl: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  totalTokens: () => number;
};

let seq = 0;
const nextId = () => `att-${Date.now()}-${++seq}`;

export const useAttachmentsStore = create<AttachmentsState>((set, get) => ({
  items: [],
  addPaths: (kind, paths) => {
    if (paths.length === 0) return;
    const seen = new Set(
      get()
        .items.filter((i) => i.path)
        .map((i) => i.path),
    );
    const fresh: Attachment[] = paths
      .filter((p) => !seen.has(p))
      .map((p) => ({
        id: nextId(),
        kind,
        name: basename(p),
        path: p,
        approxTokens: DEFAULT_TOKENS[kind],
      }));
    if (fresh.length === 0) return;
    set({ items: [...get().items, ...fresh] });
  },
  addUrl: (rawUrl) => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    const seen = new Set(
      get()
        .items.filter((i) => i.url)
        .map((i) => i.url),
    );
    if (seen.has(trimmed)) return;
    set({
      items: [
        ...get().items,
        {
          id: nextId(),
          kind: "url",
          name: urlDisplay(trimmed),
          url: trimmed,
          approxTokens: DEFAULT_TOKENS.url,
        },
      ],
    });
  },
  remove: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
  clear: () => set({ items: [] }),
  totalTokens: () => get().items.reduce((sum, i) => sum + i.approxTokens, 0),
}));
