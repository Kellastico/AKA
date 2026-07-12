import { useRef, useState } from "react";
import {
  HandPalm,
  Lightning,
  PencilSimple,
  type Icon,
} from "@phosphor-icons/react";
import { Popover } from "../Popover";
import { APPROVAL_MODES, type ApprovalMode } from "../../lib/builtin-approvals";
import { useActiveSessionRunning, useChatStore } from "../../stores/use-chat-store";
import { PickerOption, PickerPillButton } from "./PickerPill";

const APPROVAL_ICONS: Record<ApprovalMode, Icon> = {
  ask: HandPalm,
  acceptEdits: PencilSimple,
  auto: Lightning,
};

/**
 * Approval-mode picker for the built-in Execute loop (None agent + Execute):
 * Ask first / Accept edits / Auto. Only rendered when that loop is what a send
 * would launch — external agents run their own approval story (PTY prompts),
 * and Strategize's read-only floor never asks. Persisted per project alongside
 * the chat mode.
 */
export function ApprovalPicker({ compact }: { compact?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const approvalMode = useChatStore((s) => s.approvalMode);
  const setApprovalMode = useChatStore((s) => s.setApprovalMode);
  const running = useActiveSessionRunning();
  const current = APPROVAL_MODES.find((m) => m.id === approvalMode)!;
  const Icon = APPROVAL_ICONS[approvalMode];

  return (
    <>
      <PickerPillButton
        buttonRef={ref}
        icon={<Icon size={14} />}
        label={current.label}
        open={open}
        compact={compact}
        disabled={running}
        disabledTitle="Wait for the run to finish, or press Stop, before changing the approval mode."
        onClick={() => setOpen((v) => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref}>
        {APPROVAL_MODES.map((m) => {
          const OptionIcon = APPROVAL_ICONS[m.id];
          return (
            <PickerOption
              key={m.id}
              selected={m.id === approvalMode}
              onClick={() => {
                setApprovalMode(m.id);
                setOpen(false);
              }}
            >
              <div className="flex items-start gap-2">
                <OptionIcon size={14} />
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
