import { useEffect, useState } from "react";
import { MagicWand, Play, X } from "@phosphor-icons/react";
import {
  DEFAULT_PROJECT_CONFIG,
  loadConfig,
  saveConfig,
  type ProjectConfig,
} from "../lib/tauri/commands";
import { detectDevServer } from "../lib/detect-dev-server";
import { useDevServerStore } from "../stores/use-dev-server-store";

const splitArgs = (raw: string): string[] =>
  raw.trim().length === 0 ? [] : raw.trim().split(/\s+/);

/**
 * First-run prompt for the dev-server command. Surfaces when the user clicks
 * Start in a browser pane and the project has no `dev_server.cmd` saved.
 * Saves the answer back to project config so subsequent starts skip this
 * modal entirely.
 */
export function DevServerPromptModal({
  projectPath,
  open,
  onClose,
}: {
  projectPath: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [cmd, setCmd] = useState("npm");
  const [argsRaw, setArgsRaw] = useState("run dev");
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const startServer = useDevServerStore((s) => s.start);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setErr(null);
      setDetectNote(null);
    }
  }, [open]);

  // Run detection once when the modal opens so the user lands on a pre-filled,
  // sensible default instead of "npm run dev" for non-Node projects.
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    setDetecting(true);
    void detectDevServer(projectPath)
      .then((d) => {
        if (cancelled || !d) return;
        setCmd(d.cmd);
        setArgsRaw(d.args.join(" "));
        setDetectNote(d.reason);
      })
      .catch(() => {
        // silent — keep the default placeholders
      })
      .finally(() => {
        if (!cancelled) setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectPath]);

  const reDetect = async () => {
    if (!projectPath) return;
    setDetecting(true);
    setErr(null);
    try {
      const d = await detectDevServer(projectPath);
      if (d) {
        setCmd(d.cmd);
        setArgsRaw(d.args.join(" "));
        setDetectNote(d.reason);
      } else {
        setDetectNote("Couldn't infer a dev server for this project");
      }
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (!projectPath) {
      setErr("No active project");
      return;
    }
    const trimmed = cmd.trim();
    if (!trimmed) {
      setErr("Command is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      let cfg: ProjectConfig;
      try {
        cfg = await loadConfig(projectPath);
      } catch {
        cfg = { ...DEFAULT_PROJECT_CONFIG };
      }
      const next: ProjectConfig = {
        ...cfg,
        dev_server: { cmd: trimmed, args: splitArgs(argsRaw) },
      };
      await saveConfig(projectPath, next);
      onClose();
      await startServer(projectPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="dev-server-prompt"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-2xl border border-white/15 bg-zinc-900/95 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">Start dev server</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/40 hover:bg-white/10 hover:text-white/80"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <p className="mb-3 text-xs text-white/55">
          AKA will run this command in your project root. Saved to{" "}
          <code className="text-white/75">.äkä/config.json</code> — next time
          it&apos;s one click.
        </p>

        <button
          onClick={() => void reDetect()}
          disabled={detecting || !projectPath}
          className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-100 transition-colors hover:bg-fuchsia-500/20 disabled:opacity-50"
        >
          <MagicWand size={13} weight="fill" className="text-fuchsia-300" />
          {detecting ? "Inspecting project…" : "Detect from project"}
        </button>

        {detectNote && (
          <p className="mb-3 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white/60">
            <span className="text-white/45">Inferred:</span> {detectNote}
          </p>
        )}

        <label className="mb-1 block text-[11px] uppercase tracking-wide text-white/40">
          Command
        </label>
        <input
          autoFocus
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          spellCheck={false}
          className="mb-3 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white/90 outline-none focus:border-white/25"
        />

        <label className="mb-1 block text-[11px] uppercase tracking-wide text-white/40">
          Arguments
        </label>
        <input
          value={argsRaw}
          onChange={(e) => setArgsRaw(e.target.value)}
          spellCheck={false}
          placeholder="run dev"
          className="mb-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white/90 outline-none focus:border-white/25"
        />
        <p className="mb-4 text-[11px] text-white/35">
          Space-separated. e.g. <code>run dev</code>, <code>start --port 4000</code>
        </p>

        {err && (
          <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {err}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-emerald-400/90 px-3 py-1.5 text-xs font-medium text-black hover:bg-emerald-300 disabled:opacity-50"
          >
            <Play size={12} weight="fill" />
            {busy ? "Starting…" : "Save & start"}
          </button>
        </div>
      </div>
    </div>
  );
}
