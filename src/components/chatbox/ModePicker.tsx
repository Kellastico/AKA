import { useRef, useState } from "react";
import {
  Chat,
  CursorClick,
  ListNumbers,
  type Icon,
} from "@phosphor-icons/react";
import { Popover } from "../Popover";
import {
  CHAT_MODES,
  ChatMode,
  useActiveSessionRunning,
  useChatStore,
} from "../../stores/use-chat-store";
import { PickerOption, PickerPillButton } from "./PickerPill";

const MODE_ICONS: Record<ChatMode, Icon> = {
  ask: Chat,
  edit: ListNumbers,
  agent: CursorClick,
};

export function ModePicker({ compact }: { compact?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const mode = useChatStore((s) => s.mode);
  const setMode = useChatStore((s) => s.setMode);
  const running = useActiveSessionRunning();
  const current = CHAT_MODES.find((m) => m.id === mode)!;
  const Icon = MODE_ICONS[mode];

  return (
    <>
      <PickerPillButton
        buttonRef={ref}
        icon={<Icon size={14} />}
        label={current.label}
        open={open}
        compact={compact}
        disabled={running}
        disabledTitle="Wait for the response to finish, or press Stop, before changing chat mode."
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref}>
        {CHAT_MODES.map((m) => {
          const ModeIcon = MODE_ICONS[m.id];
          return (
            <PickerOption
              key={m.id}
              selected={m.id === mode}
              onClick={() => {
                setMode(m.id);
                setOpen(false);
              }}
            >
              <div className="flex items-start gap-2">
                <ModeIcon size={14} />
                <div className="flex flex-col">
                  <span>{m.label}</span>
                  <span className="text-[11px] text-ink/40">{m.hint}</span>
                </div>
              </div>
            </PickerOption>
          );
        })}
      </Popover>
    </>
  );
}
