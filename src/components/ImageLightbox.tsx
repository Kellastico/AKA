import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { convertFileSrc } from "@tauri-apps/api/core";

type Props = {
  /** Local filesystem path to the image. Converted via Tauri asset protocol. */
  path: string;
  /** Caption shown above the close button. Usually the file basename. */
  name?: string;
  onClose: () => void;
};

export function ImageLightbox({ path, name, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const src = convertFileSrc(path);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name ?? "Image preview"}
      onClick={onClose}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-md animate-message-in"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/80 backdrop-blur-md hover:bg-white/20 hover:text-white"
      >
        <X size={16} />
      </button>
      {name && (
        <div className="pointer-events-none absolute left-4 top-4 max-w-[60%] truncate rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-white/80 backdrop-blur-md">
          {name}
        </div>
      )}
      <img
        src={src}
        alt={name ?? "preview"}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] max-w-[92vw] rounded-lg object-contain shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
      />
    </div>,
    document.body,
  );
}
