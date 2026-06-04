import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  Copy,
  DownloadSimple,
  Trash,
  UploadSimple,
  Warning,
  Wrench,
} from "@phosphor-icons/react";
import {
  useCustomAgentsStore,
  type CustomAgent,
} from "../stores/use-custom-agents-store";
import { useAgentsStore, type LLMOwnership } from "../stores/use-agents-store";
import { useRuntimeStore } from "../features/01-llm-provider/use-runtime-store";
import {
  formatCommand,
  hasModelPlaceholder,
  hasTaskPlaceholder,
  parseCommand,
} from "../lib/agent-command";
import { parseRecipe, recipeToJson, toRecipe } from "../lib/agent-recipe";
import {
  wrapperCommand,
  wrapperFilename,
  wrapperStub,
  type WrapperLang,
} from "../lib/agent-wrapper";
import {
  pickFiles,
  readTextFile,
  saveFileDialog,
  writeTextFile,
} from "../lib/tauri/commands";

const TOKENS: { token: string; hint: string }[] = [
  { token: "{task}", hint: "the prompt" },
  { token: "{model}", hint: "selected model" },
  { token: "{base_url}", hint: "LLM server URL" },
];

/**
 * Register an agent the simple way: paste the command you'd run in a terminal,
 * mark where the prompt goes with `{task}`, and AKA stores it. Everything else
 * (name, LLM ownership, the parsed argv) is auto-derived and tucked under
 * "Advanced". Recipes (paste/import) and a wrapper-stub generator cover the
 * agents that need more than a one-liner.
 */
export function CustomAgentPanel({
  editing,
  onDone,
}: {
  editing?: CustomAgent | null;
  onDone: () => void;
}) {
  const add = useCustomAgentsStore((s) => s.add);
  const update = useCustomAgentsStore((s) => s.update);
  const remove = useCustomAgentsStore((s) => s.remove);
  const refreshAgents = useAgentsStore((s) => s.refresh);
  const selectAgent = useAgentsStore((s) => s.selectAgent);

  const [command, setCommand] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [ownership, setOwnership] = useState<LLMOwnership>("aka");
  const [ownershipTouched, setOwnershipTouched] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showWrapper, setShowWrapper] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const [importText, setImportText] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<"export" | "wrapper" | null>(null);
  const [wrapperLang, setWrapperLang] = useState<WrapperLang>("sh");

  const commandRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setCommand(formatCommand(editing.bin, editing.args));
      setName(editing.name);
      setNameTouched(true);
      setOwnership(editing.llmOwnership);
      setOwnershipTouched(true);
    } else {
      setCommand("");
      setName("");
      setNameTouched(false);
      setOwnership("aka");
      setOwnershipTouched(false);
    }
    setErr(null);
    setBusy(false);
    setSubmitted(false);
    setShowAdvanced(false);
    setShowImport(false);
    setShowWrapper(false);
    setShowExport(false);
    setImportText("");
    setImportErr(null);
    setImportNote(null);
  }, [editing]);

  const parsed = useMemo(() => parseCommand(command), [command]);
  const effectiveName = (nameTouched ? name : parsed.bin).trim();
  const effectiveOwnership: LLMOwnership = ownershipTouched
    ? ownership
    : hasModelPlaceholder(command)
      ? "aka"
      : "agent";

  const commandError = submitted && !parsed.bin;
  const canSave = !!parsed.bin && !!effectiveName;
  const missingTask = command.trim() !== "" && !hasTaskPlaceholder(command);

  const insertToken = (token: string) => {
    const ta = commandRef.current;
    const start = ta?.selectionStart ?? command.length;
    const end = ta?.selectionEnd ?? command.length;
    const before = command.slice(0, start);
    const after = command.slice(end);
    const needSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needSpace ? " " : "") + token;
    setCommand(before + insert + after);
    requestAnimationFrame(() => {
      if (!ta) return;
      const pos = before.length + insert.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const handleSave = async () => {
    setSubmitted(true);
    if (!parsed.bin || !effectiveName) return;
    setErr(null);

    // Prevent duplicates: refuse an agent whose command (bin + args) — or whose
    // display name — already exists in the registry. When editing, the agent
    // being edited is excluded so saving it unchanged isn't flagged.
    const norm = (s: string) => s.trim();
    const sameArgs = (a: string[], b: string[]) =>
      a.length === b.length && a.every((x, i) => norm(x) === norm(b[i] ?? ""));
    const existing = useCustomAgentsStore
      .getState()
      .agents.filter((a) => a.id !== editing?.id);
    const cmdDup = existing.find(
      (a) => norm(a.bin) === norm(parsed.bin) && sameArgs(a.args, parsed.args),
    );
    if (cmdDup) {
      setErr(`This agent is already in your list as “${cmdDup.name}”. Edit or delete that one instead.`);
      return;
    }
    const nameDup = existing.find(
      (a) => a.name.trim().toLowerCase() === effectiveName.toLowerCase(),
    );
    if (nameDup) {
      setErr(`An agent named “${nameDup.name}” already exists — choose a different name.`);
      return;
    }

    setBusy(true);
    try {
      const payload = {
        name: effectiveName,
        bin: parsed.bin,
        args: parsed.args,
        llmOwnership: effectiveOwnership,
      };
      if (editing) {
        await update(editing.id, payload);
        await refreshAgents();
        useRuntimeStore.getState().pushToast({
          kind: "success",
          text: `Updated agent “${effectiveName}”`,
        });
      } else {
        const created = await add(payload);
        await refreshAgents();
        selectAgent(created.id);
        useRuntimeStore.getState().pushToast({
          kind: "success",
          text: `Added agent “${effectiveName}”`,
        });
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    const removedName = editing.name;
    setBusy(true);
    try {
      await remove(editing.id);
      await refreshAgents();
      useRuntimeStore.getState().pushToast({
        kind: "danger",
        text: `Removed agent “${removedName}”`,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const applyRecipe = (text: string) => {
    const res = parseRecipe(text);
    if (!res.ok) {
      setImportErr(res.error);
      return;
    }
    setCommand(res.recipe.command);
    setName(res.recipe.name);
    setNameTouched(true);
    if (res.recipe.llmOwnership) {
      setOwnership(res.recipe.llmOwnership);
      setOwnershipTouched(true);
    }
    setImportNote(res.recipe.notes ?? null);
    setImportErr(null);
    setShowImport(false);
  };

  const loadRecipeFile = async () => {
    try {
      const [path] = await pickFiles();
      if (!path) return;
      const file = await readTextFile(path);
      setImportText(file.contents);
      applyRecipe(file.contents);
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
    }
  };

  const exportJson = useMemo(() => {
    if (!parsed.bin) return "";
    return recipeToJson(
      toRecipe({
        name: effectiveName || parsed.bin,
        bin: parsed.bin,
        args: parsed.args,
        llmOwnership: effectiveOwnership,
      }),
    );
  }, [parsed.bin, parsed.args, effectiveName, effectiveOwnership]);

  const copy = async (text: string, which: "export" | "wrapper") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };

  const saveWrapper = async () => {
    const stub = wrapperStub(wrapperLang);
    try {
      const path = await saveFileDialog({
        defaultPath: wrapperFilename(wrapperLang),
      });
      if (!path) return;
      await writeTextFile(path, stub);
      setCommand(wrapperCommand(wrapperLang, path));
      // The wrapper reads AKA_MODEL from the env each run, so the model stays
      // switchable → AKA-managed ownership.
      setOwnership("aka");
      setOwnershipTouched(true);
      setShowWrapper(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3 px-1 py-1 text-white">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-1">
        <button
          onClick={onDone}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-lg p-1 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-40"
          aria-label="Back"
        >
          <CaretLeft size={12} weight="bold" />
        </button>
        <span className="text-[12px] font-medium text-white/80">
          {editing ? "Edit agent" : "Add an agent"}
        </span>
      </div>

      {/* Command — the one field that matters */}
      <PanelField
        label="Command"
        hint={
          <>
            Paste the command you'd run in your terminal. Put{" "}
            <code className="rounded bg-white/10 px-0.5 text-white/70">{"{task}"}</code>{" "}
            where the prompt should go.
          </>
        }
        error={commandError ? "Enter a command to run your agent" : null}
      >
        <textarea
          ref={commandRef}
          autoFocus
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={"aider --model openai/{model} --message {task}"}
          spellCheck={false}
          rows={3}
          className={[
            "w-full resize-y rounded-lg border bg-black/30 px-2 py-1.5 font-mono text-xs leading-relaxed text-white outline-none placeholder:text-white/25",
            commandError ? "border-red-400/60 focus:border-red-400/80" : "border-white/15 focus:border-white/40",
          ].join(" ")}
        />
      </PanelField>

      {/* Token chips */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-white/35">Insert:</span>
        {TOKENS.map((t) => (
          <button
            key={t.token}
            type="button"
            onClick={() => insertToken(t.token)}
            title={t.hint}
            className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-fuchsia-200/80 hover:border-fuchsia-400/40 hover:bg-fuchsia-500/10"
          >
            {t.token}
          </button>
        ))}
      </div>

      {/* Non-blocking prompt-delivery note */}
      {missingTask && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-400/25 bg-amber-500/[0.07] px-2 py-1.5 text-[10px] leading-snug text-amber-100/80">
          <Warning size={12} weight="fill" className="mt-px shrink-0 text-amber-300/90" />
          <span>
            No <code className="font-mono">{"{task}"}</code> in the command — your
            agent will receive the prompt via the <code className="font-mono">$AKA_TASK</code>{" "}
            env var. Add <code className="font-mono">{"{task}"}</code> if it expects
            the prompt as an argument.
          </span>
        </div>
      )}

      {effectiveName && (
        <p className="px-0.5 text-[10px] text-white/40">
          Appears in the picker as{" "}
          <span className="text-white/70">{effectiveName}</span>
        </p>
      )}

      {importNote && (
        <p className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] text-white/50">
          Recipe note: {importNote}
        </p>
      )}

      {/* Advanced */}
      <Disclosure
        open={showAdvanced}
        onToggle={() => setShowAdvanced((v) => !v)}
        label="Advanced"
      >
        <RequiredField
          label="Name"
          hint="Defaults to the command name"
          error={null}
        >
          <input
            value={nameTouched ? name : parsed.bin}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder="e.g. My Agent"
            spellCheck={false}
            className={inputClass(false)}
          />
        </RequiredField>

        <PanelField
          label="Who manages the LLM connection?"
          hint="Controls whether you can switch models mid-session"
        >
          <div className="flex flex-col gap-1">
            <OwnershipChoice
              value="aka"
              current={effectiveOwnership}
              onPick={(v) => {
                setOwnership(v);
                setOwnershipTouched(true);
              }}
              title="AKA handles it"
              body="AKA passes the model each run. You can switch models anytime."
            />
            <OwnershipChoice
              value="agent"
              current={effectiveOwnership}
              onPick={(v) => {
                setOwnership(v);
                setOwnershipTouched(true);
              }}
              title="My agent handles it"
              body="Your agent connects to the LLM itself. Model locks once the session starts."
            />
          </div>
        </PanelField>

        <PanelField label="Parsed">
          <div className="rounded-md bg-black/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-white/60">
            <div>
              <span className="text-white/35">bin </span>
              {parsed.bin || <span className="text-white/30">—</span>}
            </div>
            <div className="break-all">
              <span className="text-white/35">args </span>
              {parsed.args.length > 0 ? `[ ${parsed.args.join(" · ")} ]` : "[ ]"}
            </div>
          </div>
        </PanelField>
      </Disclosure>

      {/* Import recipe */}
      <Disclosure
        open={showImport}
        onToggle={() => setShowImport((v) => !v)}
        label="Import a recipe"
        icon={<UploadSimple size={11} />}
      >
        <p className="text-[10px] leading-relaxed text-white/45">
          Paste a shared recipe (JSON) to fill in the form, or load a{" "}
          <span className="font-mono">.json</span> file.
        </p>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={'{ "akaRecipe": 1, "name": "…", "command": "… {task}" }'}
          spellCheck={false}
          rows={3}
          className="w-full resize-y rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-white outline-none placeholder:text-white/25 focus:border-white/40"
        />
        {importErr && (
          <span className="text-[10px] text-red-300">{importErr}</span>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => applyRecipe(importText)}
            className="rounded-md border border-fuchsia-400/30 bg-fuchsia-500/10 px-2.5 py-1 text-[11px] text-fuchsia-200 hover:bg-fuchsia-500/20"
          >
            Apply recipe
          </button>
          <button
            onClick={() => void loadRecipeFile()}
            className="rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-white/60 hover:bg-white/10"
          >
            Load .json…
          </button>
        </div>
      </Disclosure>

      {/* Export recipe */}
      {parsed.bin && (
        <Disclosure
          open={showExport}
          onToggle={() => setShowExport((v) => !v)}
          label="Export as recipe"
          icon={<DownloadSimple size={11} />}
        >
          <p className="text-[10px] leading-relaxed text-white/45">
            Share this agent — copy the recipe JSON below.
          </p>
          <pre className="max-h-32 overflow-auto rounded-md border border-white/10 bg-black/40 p-2 font-mono text-[10px] leading-snug text-white/70">
            {exportJson}
          </pre>
          <button
            onClick={() => void copy(exportJson, "export")}
            className="inline-flex items-center gap-1 self-start rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/10"
          >
            {copied === "export" ? <Check size={11} weight="bold" /> : <Copy size={11} />}
            {copied === "export" ? "Copied" : "Copy recipe"}
          </button>
        </Disclosure>
      )}

      {/* Wrapper generator */}
      <Disclosure
        open={showWrapper}
        onToggle={() => setShowWrapper((v) => !v)}
        label="Need a wrapper?"
        icon={<Wrench size={11} />}
      >
        <p className="text-[10px] leading-relaxed text-white/45">
          For interactive or env-only agents: generate a starter script that
          reads AKA's env (<span className="font-mono">$AKA_MODEL</span>,{" "}
          <span className="font-mono">$AKA_TASK</span>, …) and launches your
          agent. Edit the one line that runs it.
        </p>
        <div className="flex gap-1">
          {(["sh", "python"] as WrapperLang[]).map((lang) => (
            <button
              key={lang}
              onClick={() => setWrapperLang(lang)}
              className={[
                "rounded-md border px-2 py-0.5 text-[11px]",
                wrapperLang === lang
                  ? "border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-100"
                  : "border-white/10 text-white/55 hover:bg-white/10",
              ].join(" ")}
            >
              {lang === "sh" ? "shell" : "python"}
            </button>
          ))}
        </div>
        <pre className="max-h-36 overflow-auto rounded-md border border-white/10 bg-black/40 p-2 font-mono text-[10px] leading-snug text-white/70">
          {wrapperStub(wrapperLang)}
        </pre>
        <div className="flex gap-2">
          <button
            onClick={() => void copy(wrapperStub(wrapperLang), "wrapper")}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/10"
          >
            {copied === "wrapper" ? <Check size={11} weight="bold" /> : <Copy size={11} />}
            {copied === "wrapper" ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => void saveWrapper()}
            className="rounded-md border border-fuchsia-400/30 bg-fuchsia-500/10 px-2.5 py-1 text-[11px] text-fuchsia-200 hover:bg-fuchsia-500/20"
          >
            Save & use
          </button>
        </div>
      </Disclosure>

      {err && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200">
          {err}
        </div>
      )}

      <div className="h-px bg-white/10" />

      {/* Actions */}
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <button
            onClick={() => void handleDelete()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg border border-red-400/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200 hover:bg-red-500/20 disabled:opacity-50"
          >
            <Trash size={11} weight="bold" />
            Delete
          </button>
        ) : (
          <div />
        )}
        <div className="flex gap-2">
          <button
            onClick={onDone}
            disabled={busy}
            className="rounded-lg px-2 py-1.5 text-xs text-white/60 hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={busy}
            className={[
              "rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40",
              canSave
                ? "bg-emerald-500/80 hover:bg-emerald-400/90"
                : "bg-white/15 hover:bg-white/20",
            ].join(" ")}
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Add agent"}
          </button>
        </div>
      </div>
    </div>
  );
}

function inputClass(hasError: boolean) {
  return [
    "w-full rounded-lg border px-2 py-1.5 text-xs text-white outline-none placeholder:text-white/25 transition-colors",
    hasError
      ? "border-red-400/60 bg-red-500/8 focus:border-red-400/80"
      : "border-white/15 bg-black/30 focus:border-white/40",
  ].join(" ");
}

/** Collapsible section with a caret + optional leading icon. */
function Disclosure({
  open,
  onToggle,
  label,
  icon,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-[11px] font-medium text-white/55 hover:text-white/85"
      >
        {open ? (
          <CaretDown size={11} className="shrink-0 text-white/40" />
        ) : (
          <CaretRight size={11} className="shrink-0 text-white/40" />
        )}
        {icon}
        {label}
      </button>
      {open && (
        <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-2">
          {children}
        </div>
      )}
    </div>
  );
}

function RequiredField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
        {label}
      </span>
      {children}
      {error ? (
        <span className="text-[10px] text-red-300">{error}</span>
      ) : hint ? (
        <span className="text-[10px] text-white/35">{hint}</span>
      ) : null}
    </div>
  );
}

function PanelField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
        {label}
      </span>
      {children}
      {error ? (
        <span className="text-[10px] text-red-300">{error}</span>
      ) : hint ? (
        <span className="text-[10px] leading-relaxed text-white/35">{hint}</span>
      ) : null}
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
        "flex w-full flex-col items-start gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors",
        picked
          ? "border-fuchsia-400/40 bg-fuchsia-500/8"
          : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.05]",
      ].join(" ")}
    >
      <span className="text-[11px] font-medium text-white/90">{title}</span>
      <span className="text-[10px] leading-snug text-white/50">{body}</span>
    </button>
  );
}
