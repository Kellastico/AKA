import { useRef, useState } from "react";
import {
  Paperclip,
  File,
  Folder,
  Image,
  Link,
  type Icon,
} from "@phosphor-icons/react";
import { Popover } from "../Popover";
import { Tooltip } from "../Tooltip";
import {
  AttachmentKind,
  useAttachmentsStore,
} from "../../stores/use-attachments-store";
import { useRuntimeStore } from "../../features/01-llm-provider/use-runtime-store";
import { isMultimodalModel } from "../../lib/model-capabilities";
import { pickFiles, pickFolders } from "../../lib/tauri/commands";

type Option = {
  kind: AttachmentKind;
  label: string;
  Icon: Icon;
  /** True if this attachment kind requires a vision-capable model. */
  requiresMultimodal?: boolean;
};

const OPTIONS: Option[] = [
  { kind: "file", label: "Add file", Icon: File },
  { kind: "folder", label: "Add folder", Icon: Folder },
  { kind: "image", label: "Add image", Icon: Image, requiresMultimodal: true },
  { kind: "url", label: "Add URL", Icon: Link },
];

export function AttachButton({ compact }: { compact?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const addPaths = useAttachmentsStore((s) => s.addPaths);
  const addUrl = useAttachmentsStore((s) => s.addUrl);
  const selectedModelId = useRuntimeStore((s) => s.selectedModelId);
  const multimodal = isMultimodalModel(selectedModelId);

  const handlePick = async (kind: AttachmentKind) => {
    if (kind === "url") {
      setShowUrlInput(true);
      return;
    }
    setOpen(false);
    if (kind === "folder") {
      const paths = await pickFolders();
      if (paths.length > 0) addPaths("folder", paths);
      return;
    }
    if (kind === "image") {
      const paths = await pickFiles({ images: true });
      if (paths.length > 0) addPaths("image", paths);
      return;
    }
    // file
    const paths = await pickFiles();
    if (paths.length > 0) addPaths("file", paths);
  };

  const submitUrl = () => {
    addUrl(urlDraft);
    setUrlDraft("");
    setShowUrlInput(false);
    setOpen(false);
  };

  return (
    <>
      <Tooltip label="Attach context">
        <button
          ref={ref}
          onClick={() => {
            setShowUrlInput(false);
            setOpen((v) => !v);
          }}
          aria-label="Attach"
          className={[
            "inline-flex shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/70 backdrop-blur-md transition-all hover:bg-white/20 hover:border-white/25 hover:text-white active:scale-[0.97]",
            "h-10 w-10",
          ].join(" ")}
        >
          <Paperclip size={compact ? 14 : 16} />
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref}>
        {showUrlInput ? (
          <div className="p-3">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              Add URL
            </div>
            <input
              autoFocus
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitUrl();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setShowUrlInput(false);
                }
              }}
              placeholder="https://…"
              className="w-full rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setShowUrlInput(false)}
                className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={submitUrl}
                disabled={!urlDraft.trim()}
                className="rounded-md bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/30"
              >
                Add
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              Attach context
            </div>
            {OPTIONS.map(({ kind, label, Icon, requiresMultimodal }) => {
              const disabled = requiresMultimodal === true && !multimodal;
              return (
                <button
                  key={kind}
                  onClick={() => {
                    if (disabled) return;
                    void handlePick(kind);
                  }}
                  disabled={disabled}
                  title={
                    disabled
                      ? `${selectedModelId ?? "This model"} can't read images. Switch to a vision-capable model to attach images.`
                      : undefined
                  }
                  className={[
                    "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm",
                    disabled
                      ? "cursor-not-allowed text-white/30"
                      : "text-white hover:bg-white/10",
                  ].join(" ")}
                >
                  <Icon size={16} />
                  <span className="flex-1">{label}</span>
                  {disabled && (
                    <span className="ml-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/40">
                      Vision only
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
      </Popover>
    </>
  );
}
