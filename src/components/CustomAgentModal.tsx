import { useEffect, useState } from "react";
import { Robot, Trash, X } from "@phosphor-icons/react";
import {
  useCustomAgentsStore,
  type CustomAgent,
} from "../stores/use-custom-agents-store";
import { useAgentsStore, type LLMOwnership } from "../stores/use-agents-store";

/**
 * Add / edit / remove a user-level custom agent. Opened from the Agent
 * picker. On save, persists to the custom-agents store and refreshes
 * use-agents-store so the new entry appears in the picker immediately;
 * the newly-added entry is also auto-selected for the active project.
 *
 * Args are entered one-per-line so users can include arguments with spaces
 * (e.g., a multi-word `--message` value) without having to quote them.
 */
export function CustomAgentModal({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  /** When set, the form is pre-filled and Save updates instead of creates. */
  editing?: CustomAgent | null;
}) {
  const add = useCustomAgentsStore((s) => s.add);
  const update = useCustomAgentsStore((s) => s.update);
  const remove = useCustomAgentsStore((s) => s.remove);
  const refreshAgents = useAgentsStore((s) => s.refresh);
  const selectAgent = useAgentsStore((s) => s.selectAgent);

  const [name, setName] = useState("");
  const [bin, setBin] = useState("");
  const [argsRaw, setArgsRaw] = useState("");
  const [ownership, setOwnership] = useState<LLMOwnership>("aka");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset / hydrate the form whenever the modal opens or the editing target
  // changes. Without this, opening a fresh "Add" right after editing would
  // still show the previous values.
  useEffect(() => {
    if (!open) {
      setErr(null);
      setBusy(false);
      return;
    }
    if (editing) {
      setName(editing.name);
      setBin(editing.bin);
      setArgsRaw(editing.args.join("\n"));
      setOwnership(editing.llmOwnership);
    } else {
      setName("");
      setBin("");
      setArgsRaw("");
      setOwnership("aka");
    }
  }, [open, editing]);

  // Esc closes when not busy.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const parsedArgs = argsRaw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const handleSave = async () => {
    const n = name.trim();
    const b = bin.trim();
    if (!n) {
      setErr("Name is required");
      return;
    }
    if (!b) {
      setErr("Binary is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload = { name: n, bin: b, args: parsedArgs, llmOwnership: ownership };
      if (editing) {
        await update(editing.id, payload);
        await refreshAgents();
      } else {
        const created = await add(payload);
        await refreshAgents();
        // Auto-select so the user sees their new agent in the pill immediately.
        selectAgent(created.id);
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await remove(editing.id);
      await refreshAgents();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="custom-agent-modal"
      className="fixed inset-0 z-[115] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={busy ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-morph-in w-[520px] max-w-[92vw] rounded-2xl border border-white/12 bg-zinc-900/97 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
      >
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Robot size={18} weight="duotone" className="text-fuchsia-300" />
            <h2 className="text-sm font-medium">
              {editing ? "Edit custom agent" : "Add custom agent"}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/40 hover:bg-white/10 hover:text-white/80 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <p className="mb-4 text-[12px] text-white/55">
          Wire any binary or wrapper script as a selectable agent. Saved to
          your user profile — appears in every project&apos;s Agent picker.
        </p>

        {/* Name */}
        <Field label="Name" hint="What you'll see in the picker">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="LangChain ReAct"
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/90 outline-none focus:border-white/25"
          />
        </Field>

        {/* Bin */}
        <Field label="Binary" hint="Command on your PATH (e.g. python3, node, bash, ./myagent)">
          <input
            value={bin}
            onChange={(e) => setBin(e.target.value)}
            placeholder="python3"
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white/90 outline-none focus:border-white/25"
          />
        </Field>

        {/* Args */}
        <Field
          label="Arguments"
          hint="One per line. Use {model} / {base_url} / {task} as placeholders."
        >
          <textarea
            value={argsRaw}
            onChange={(e) => setArgsRaw(e.target.value)}
            placeholder={"/Users/you/agents/react.py\n{model}\n{base_url}\n{task}"}
            spellCheck={false}
            rows={5}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs leading-relaxed text-white/90 outline-none focus:border-white/25"
          />
        </Field>

        {/* LLM ownership */}
        <Field
          label="LLM ownership"
          hint="Controls whether the Model pill stays switchable mid-session."
        >
          <div className="flex flex-col gap-1.5">
            <OwnershipChoice
              value="aka"
              current={ownership}
              onPick={setOwnership}
              title="ÄKÄ orchestrates"
              body="AKA passes the model per call via {model}. Model pill stays switchable per-message."
            />
            <OwnershipChoice
              value="agent"
              current={ownership}
              onPick={setOwnership}
              title="Agent owns the connection"
              body="The agent holds its own LLM connection at spawn. Model pill locks after the first message."
            />
          </div>
        </Field>

        {err && (
          <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
            {err}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-2">
          {editing ? (
            <button
              onClick={() => void handleDelete()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/20 disabled:opacity-50"
            >
              <Trash size={12} weight="bold" />
              Delete
            </button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={busy}
              className="rounded-md bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-fuchsia-400 disabled:opacity-50"
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Add agent"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label className="text-[11px] uppercase tracking-wide text-white/40">
        {label}
      </label>
      {children}
      {hint && <span className="text-[11px] text-white/35">{hint}</span>}
    </div>
  );
}

function OwnershipChoice({
  value,
  current,
  onPick,
  title,
  body,
}: {
  value: LLMOwnership;
  current: LLMOwnership;
  onPick: (v: LLMOwnership) => void;
  title: string;
  body: string;
}) {
  const picked = current === value;
  return (
    <button
      onClick={() => onPick(value)}
      className={[
        "flex w-full flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
        picked
          ? "border-fuchsia-400/40 bg-fuchsia-500/8"
          : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.05]",
      ].join(" ")}
    >
      <span className="text-[12px] font-medium text-white/90">{title}</span>
      <span className="text-[11px] leading-snug text-white/55">{body}</span>
    </button>
  );
}
