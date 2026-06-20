import { useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";

/**
 * Copy-to-clipboard control with inline "Copied" feedback. Used on both the
 * user's own messages and the agent's final reply so either can be re-copied.
 *
 * Writes raw text via the Clipboard API (no browser storage). On failure
 * (e.g. clipboard blocked in a non-secure context) it degrades quietly,
 * leaving the button unchanged.
 */
export function CopyButton({
  text,
  label = true,
  className = "",
}: {
  text: string;
  label?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — leave the button unchanged.
    }
  };

  return (
    <button
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy"}
      className={[
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]",
        "text-ink/55 hover:bg-ink/5 hover:text-ink/80",
        copied ? "text-emerald-300" : "",
        className,
      ].join(" ")}
    >
      {copied ? <Check size={11} weight="bold" /> : <Copy size={11} />}
      {label && (copied ? "Copied" : "Copy")}
    </button>
  );
}
