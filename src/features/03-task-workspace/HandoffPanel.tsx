import { useState } from "react";
import {
  ArrowsLeftRight,
  CaretDown,
  CaretRight,
  CircleNotch,
  Warning,
} from "@phosphor-icons/react";
import { useSessionStore, type HandoffEntry } from "../../stores/use-session-store";
import { Collapse } from "../../components/Collapse";

/**
 * Renders the session-handoff audit trail above the agent output: a small
 * "Summarizing…" pill while a swap is in flight, plus one collapsible block
 * per completed handoff so the user can read what context was carried into
 * the new model or agent. Failed handoffs surface a warning in-line.
 */
export function HandoffPanel() {
  const summarizing = useSessionStore((s) => s.summarizing);
  const handoffs = useSessionStore((s) => s.handoffs);

  if (!summarizing && handoffs.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {summarizing && (
        <div className="inline-flex items-center gap-2 self-start rounded-md border border-sky-400/30 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-200">
          <CircleNotch size={12} weight="bold" className="animate-spin" />
          Summarizing session before handoff…
        </div>
      )}
      {handoffs.map((h) => (
        <HandoffBlock key={h.id} entry={h} />
      ))}
    </div>
  );
}

function HandoffBlock({ entry }: { entry: HandoffEntry }) {
  const [open, setOpen] = useState(entry.status === "failed");
  const kindLabel = entry.kind === "model" ? "LLM" : "Agent";

  if (entry.status === "running") {
    // Already covered by the top-level summarizing pill — skip to avoid noise.
    return null;
  }

  const failed = entry.status === "failed";
  const tone = failed
    ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
    : "border-white/10 bg-white/5 text-white/80";

  return (
    <div className={`rounded-md border px-2.5 py-1.5 text-xs ${tone}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        {open ? (
          <CaretDown size={12} weight="bold" />
        ) : (
          <CaretRight size={12} weight="bold" />
        )}
        {failed ? (
          <Warning size={12} weight="fill" />
        ) : (
          <ArrowsLeftRight size={12} weight="bold" />
        )}
        <span className="font-medium">Session handoff summary</span>
        <span className="text-white/50">
          · {kindLabel}: {entry.previous} → {entry.next}
        </span>
      </button>
      <Collapse open={open}>
        <div className="mt-1.5 whitespace-pre-wrap border-t border-white/10 pt-1.5 font-normal text-white/70">
          {failed
            ? `Handoff summary failed — starting fresh. Previous session context was not carried forward.${
                entry.error ? `\n\n(${entry.error})` : ""
              }`
            : entry.summary ?? ""}
        </div>
      </Collapse>
    </div>
  );
}
