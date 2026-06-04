import { useState } from "react";
import {
  File,
  Folder,
  Image,
  Link,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { Tooltip } from "../Tooltip";
import { ImageLightbox } from "../ImageLightbox";
import {
  Attachment,
  AttachmentKind,
  useAttachmentsStore,
} from "../../stores/use-attachments-store";

const ICONS: Record<AttachmentKind, Icon> = {
  file: File,
  folder: Folder,
  image: Image,
  url: Link,
};

export function AttachmentChips() {
  const items = useAttachmentsStore((s) => s.items);
  const remove = useAttachmentsStore((s) => s.remove);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string | undefined>(undefined);

  if (items.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-1.5 px-1 pb-2">
        {items.map((item) => (
          <Chip
            key={item.id}
            item={item}
            onRemove={() => remove(item.id)}
            onPreview={
              item.kind === "image" && item.path
                ? () => {
                    setPreviewPath(item.path!);
                    setPreviewName(item.name);
                  }
                : undefined
            }
          />
        ))}
      </div>
      {previewPath && (
        <ImageLightbox
          path={previewPath}
          name={previewName}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </>
  );
}

function Chip({
  item,
  onRemove,
  onPreview,
}: {
  item: Attachment;
  onRemove: () => void;
  onPreview?: () => void;
}) {
  const Icon = ICONS[item.kind];
  const bodyClass = "inline-flex items-center gap-1.5 text-left";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2 py-1 text-[11px] text-white/85 backdrop-blur-md">
      {onPreview ? (
        <button
          type="button"
          onClick={onPreview}
          aria-label={`Preview ${item.name}`}
          title="Click to preview"
          className={`${bodyClass} cursor-zoom-in hover:text-white`}
        >
          <Icon size={12} className="text-white/70" />
          <span className="max-w-[160px] truncate text-white/90">{item.name}</span>
        </button>
      ) : (
        <span className={bodyClass}>
          <Icon size={12} className="text-white/70" />
          <span className="max-w-[160px] truncate text-white/90">{item.name}</span>
        </span>
      )}
      <span className="text-white/45">~{formatTokens(item.approxTokens)}</span>
      <Tooltip label={`Remove ${item.name}`}>
        <button
          onClick={onRemove}
          className="flex h-4 w-4 items-center justify-center rounded-full text-white/50 hover:bg-white/15 hover:text-white"
          aria-label={`Remove ${item.name}`}
        >
          <X size={10} />
        </button>
      </Tooltip>
    </span>
  );
}

function formatTokens(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
