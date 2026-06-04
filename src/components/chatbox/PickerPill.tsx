import { ReactNode, Ref } from "react";
import { CaretDown, Check, Lock } from "@phosphor-icons/react";

export function PickerPillButton({
  buttonRef,
  icon,
  label,
  open,
  compact,
  disabled,
  disabledTitle,
  sessionLocked,
  sessionLockedTitle,
  dashed,
  dimmed,
  onClick,
}: {
  buttonRef: Ref<HTMLButtonElement>;
  icon: ReactNode;
  label: string;
  open: boolean;
  compact?: boolean;
  disabled?: boolean;
  /** Tooltip shown when disabled by a running response — explains why the picker is locked. */
  disabledTitle?: string;
  /**
   * True when the pill is locked for the lifetime of this session (agent/model
   * already committed). Visually distinct from the transient `disabled` state.
   */
  sessionLocked?: boolean;
  /** Override the default session-locked tooltip text. */
  sessionLockedTitle?: string;
  /**
   * Renders the pill with a dashed border — used for optional, unconfigured
   * add-CTA slots (the pill is presented as "+ Something" until configured).
   */
  dashed?: boolean;
  /**
   * Reduces opacity to signal the pill is secondary / subordinate. Still
   * clickable, just de-emphasized.
   */
  dimmed?: boolean;
  onClick: () => void;
}) {
  const isBlocked = disabled || sessionLocked;
  const title = sessionLocked
    ? (sessionLockedTitle ?? "Locked for this session — start a new session to change")
    : disabled
      ? (disabledTitle ?? label)
      : label;

  return (
    <button
      ref={buttonRef}
      onClick={isBlocked ? undefined : onClick}
      disabled={isBlocked}
      title={title}
      className={[
        "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-2xl border text-xs text-white transition-all",
        open
          ? "invisible border-transparent"
          : sessionLocked
            ? "cursor-not-allowed border-white/8 bg-white/3 opacity-50"
            : disabled
              ? "cursor-not-allowed border-white/8 bg-white/3 text-white/35"
              : dashed
                ? // Dashed add-CTA pill: amber hover (instead of the neutral
                  // white). Only the add state uses `dashed`, so this is scoped
                  // to that button; the added/white pill is left untouched below.
                  "border-dashed border-white/25 bg-transparent text-white/50 hover:border-amber-300/50 hover:bg-amber-500/10 hover:text-amber-100 active:scale-[0.97]"
                : "border-white/15 bg-white/10 backdrop-blur-md hover:bg-white/20 hover:border-white/25 active:scale-[0.97]",
        dimmed && !open ? "opacity-60" : "",
        compact ? "px-2.5" : "px-3",
      ].join(" ")}
    >
      {icon}
      {!compact && <span className="max-w-[140px] truncate">{label}</span>}
      {sessionLocked ? (
        <Lock size={10} className="shrink-0 text-ink/40" />
      ) : (
        <CaretDown
          size={10}
          className={[
            "shrink-0 transition-transform",
            disabled ? "text-ink/25" : dashed ? "text-white/30" : "text-ink/50",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      )}
    </button>
  );
}

export function PickerOption({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm text-white hover:bg-white/10"
    >
      <span className="flex w-4 shrink-0 justify-center">
        {selected && <Check size={14} className="text-ink" />}
      </span>
      <span className="flex-1">{children}</span>
    </button>
  );
}

export function PickerGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
      {children}
    </div>
  );
}
