import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CircleNotch,
  Gear,
  Lightbulb,
  MagicWand,
  Play,
  Plugs,
  Stop,
} from "@phosphor-icons/react";
import { useWorkspaceStore } from "../../stores/use-workspace-store";
import { useProjectsStore } from "../../stores/use-projects-store";
import { useDevServerStore } from "../../stores/use-dev-server-store";
import {
  clearWebviewCache,
  loadConfig,
  openExternalUrl,
  unwatchDir,
  watchDir,
} from "../../lib/tauri/commands";
import { findFix } from "../../lib/error-fixes";
import { humanizeError, isPortInUseError } from "../../lib/humanize-error";
import { runAutoFix } from "../../lib/run-auto-fix";
import { Tooltip } from "../Tooltip";
import { DevServerPromptModal } from "../DevServerPromptModal";

const DEFAULT_URL = "http://localhost:5173";

const normalize = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
};

// Stamp a changing query param onto the iframe URL so every reload is a real
// fetch. WKWebView happily serves a remounted iframe with an identical src
// straight from its HTTP cache when the dev server doesn't send no-cache
// headers (python http.server, serve, …) — which left the pane stale while a
// normal browser, where the user hits ⌘R, revalidated and looked different.
// Preserves any hash fragment (SPA hash routing).
const bustCache = (raw: string, nonce: number): string => {
  try {
    const u = new URL(raw);
    u.searchParams.set("aka_reload", String(nonce));
    return u.toString();
  } catch {
    return raw;
  }
};

const parsePort = (raw: string | undefined | null): number | null => {
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!u.port) return null;
    const n = Number(u.port);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
};

export function BrowserContent({
  paneId,
  url,
}: {
  paneId: string;
  url?: string;
}) {
  const updatePaneUrl = useWorkspaceStore((s) => s.updatePaneUrl);
  const bumpPreviewReload = useWorkspaceStore((s) => s.bumpPreviewReload);
  const previewReloadCounter = useWorkspaceStore(
    (s) => s.previewReloadCounter,
  );

  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const projects = useProjectsStore((s) => s.projects);
  const projectPath =
    projects.find((p) => p.id === activeProjectId)?.path ?? null;

  const devStatus = useDevServerStore((s) => s.status);
  const detectedUrl = useDevServerStore((s) => s.detectedUrl);
  const busyPort = useDevServerStore((s) => s.busyPort);
  const startServer = useDevServerStore((s) => s.start);
  const stopServer = useDevServerStore((s) => s.stop);
  const freePortAndRestart = useDevServerStore((s) => s.freePortAndRestart);
  const attachListeners = useDevServerStore((s) => s.attachListeners);

  const [draft, setDraft] = useState(url ?? "");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [promptOpen, setPromptOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const autoFilledRef = useRef(false);

  // Make sure dev:// events are wired even if Output pane was never opened.
  useEffect(() => {
    attachListeners();
  }, [attachListeners]);

  // Sync the input when the store URL changes from outside.
  useEffect(() => {
    setDraft(url ?? "");
  }, [url]);

  // Auto-reload when an agent run (or any other code-mutating action)
  // signals that the project's files have changed. Each bump rolls the
  // iframe's `key` forward and forces a fresh fetch — same effect as
  // clicking the reload button, but automatic.
  useEffect(() => {
    if (previewReloadCounter === 0) return;
    setReloadNonce((n) => n + 1);
  }, [previewReloadCounter]);

  // Live preview: watch the whole project tree while something is loaded in
  // the iframe, and roll the preview forward (debounced) whenever any file
  // changes — whether the user edited it, an agent wrote it, or a build step
  // emitted it. This is what makes the pane feel like "it just updates,"
  // independent of whether the dev server has its own HMR. Only active while a
  // URL is loaded so we never poll the disk for a blank preview.
  useEffect(() => {
    if (!projectPath || !url) return;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    void watchDir(projectPath);
    void listen("project://changed", () => {
      // Collapse a burst of writes (an agent touching many files, a save-all)
      // into a single reload once things settle.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => bumpPreviewReload(), 700);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      unlisten?.();
      void unwatchDir(projectPath);
    };
  }, [projectPath, url, bumpPreviewReload]);

  // Auto-fill detected dev-server URL the first time we see one — but only
  // when the user hasn't typed/loaded their own URL yet (don't yank).
  useEffect(() => {
    if (!detectedUrl || autoFilledRef.current) return;
    if (url) {
      autoFilledRef.current = true;
      return;
    }
    autoFilledRef.current = true;
    updatePaneUrl(paneId, detectedUrl);
  }, [detectedUrl, url, paneId, updatePaneUrl]);

  const go = () => {
    const next = normalize(draft || DEFAULT_URL);
    if (!next) return;
    if (next !== url) updatePaneUrl(paneId, next);
    else setReloadNonce((n) => n + 1);
  };

  // `hard` additionally wipes the webview's HTTP cache before refetching —
  // the cache-busted src only guarantees a fresh *page*; the subresources it
  // references can still come back stale from cache when the dev server sends
  // no cache headers.
  const reload = async (hard: boolean) => {
    if (hard) {
      try {
        await clearWebviewCache();
      } catch {
        // Cache clear is best-effort — still reload.
      }
    }
    setReloadNonce((n) => n + 1);
  };

  const handleStart = async () => {
    setStartError(null);
    if (!projectPath) {
      setStartError("No active project");
      return;
    }
    // Output pane is no longer auto-opened — the user opens it manually from
    // the pane "+" menu if they want to watch the dev-server log stream.
    try {
      const cfg = await loadConfig(projectPath);
      if (!cfg.dev_server?.cmd?.trim()) {
        setPromptOpen(true);
        return;
      }
      // After a failure, don't silently re-run the same broken command. Open
      // the prompt so the user can fix it (auto-detect runs on open). Port
      // conflicts are handled separately by auto-recovery + the "Free port"
      // button, so those never reach here.
      if (devStatus === "failed") {
        setPromptOpen(true);
        return;
      }
      await startServer(projectPath);
    } catch {
      // Config read failed — fall back to the prompt so the user can configure.
      setPromptOpen(true);
    }
  };

  // "recovering" is a busy state too — AKA is freeing a port and relaunching.
  const isRunning = devStatus === "running";
  const isRecovering = devStatus === "recovering";
  const isBusy = isRunning || isRecovering;
  const startStopDisabled = !projectPath && !isBusy;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-1 px-3 pb-2">
        <Tooltip
          label={
            isRecovering
              ? "Freeing port & restarting…"
              : isRunning
                ? "Stop dev server"
                : projectPath
                  ? "Start dev server"
                  : "No active project"
          }
          side="bottom"
        >
          <button
            onClick={() => (isBusy ? stopServer() : handleStart())}
            disabled={startStopDisabled}
            className={[
              "flex h-7 w-7 items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:hover:bg-transparent",
              isBusy
                ? "text-red-300/90 hover:bg-red-500/15 hover:text-red-200"
                : "text-emerald-300/90 hover:bg-emerald-400/15 hover:text-emerald-200",
            ].join(" ")}
            aria-label={isBusy ? "Stop dev server" : "Start dev server"}
          >
            {isRecovering ? (
              <CircleNotch size={14} weight="bold" className="animate-spin" />
            ) : isRunning ? (
              <Stop size={14} weight="fill" />
            ) : (
              <Play size={14} weight="fill" />
            )}
          </button>
        </Tooltip>
        <Tooltip label="Configure dev server (auto-detects project type)" side="bottom">
          <button
            onClick={() => setPromptOpen(true)}
            disabled={!projectPath || isBusy}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/55 hover:bg-white/10 hover:text-white/85 disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Configure dev server"
          >
            <Gear size={14} />
          </button>
        </Tooltip>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
          placeholder={DEFAULT_URL}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-full bg-white/8 px-3 py-1.5 font-mono text-xs text-white/85 placeholder:text-white/30 outline-none focus:bg-white/12"
        />
        <Tooltip label="Reload — ⇧-click for hard reload (clears cache)" side="bottom">
          <button
            onClick={(e) => void reload(e.shiftKey)}
            disabled={!url}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white/90 disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Reload"
          >
            <ArrowClockwise size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Open in browser" side="bottom">
          <button
            onClick={() => url && openExternalUrl(url)}
            disabled={!url}
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white/90 disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Open in default browser"
          >
            <ArrowSquareOut size={14} />
          </button>
        </Tooltip>
      </div>

      {startError && (
        <div className="mx-3 mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-200">
          {startError}
        </div>
      )}

      {isRecovering && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-sky-400/30 bg-sky-500/10 px-2.5 py-1.5 text-[11px] text-sky-100">
          <CircleNotch size={12} weight="bold" className="shrink-0 animate-spin text-sky-300" />
          <span>
            {busyPort
              ? `Port ${busyPort} was busy — freeing it and restarting the dev server…`
              : "Freeing the busy port and restarting the dev server…"}
          </span>
        </div>
      )}

      {devStatus === "failed" && !startError && (
        <DevServerFailureBanner
          port={busyPort ?? parsePort(draft) ?? parsePort(url)}
          onReconfigure={() => setPromptOpen(true)}
          onFreePort={projectPath ? (p) => freePortAndRestart(p) : null}
        />
      )}

      {url ? (
        <iframe
          ref={iframeRef}
          key={`${url}#${reloadNonce}`}
          src={bustCache(url, reloadNonce)}
          className="min-h-0 flex-1 w-full border-0 bg-white"
          title="Preview"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-white/30">
          {isRecovering ? (
            <span className="flex items-center gap-2 text-sky-200/70">
              <CircleNotch size={14} weight="bold" className="animate-spin" />
              Freeing the busy port and restarting…
            </span>
          ) : isRunning ? (
            <span>Waiting for the dev server to print a URL…</span>
          ) : (
            <>
              <span>No preview yet</span>
              <button
                onClick={handleStart}
                disabled={startStopDisabled}
                className="flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-40"
              >
                <Play size={12} weight="fill" />
                Start dev server
              </button>
              <span className="text-[11px] text-white/25">
                or type a URL above
              </span>
            </>
          )}
        </div>
      )}

      <DevServerPromptModal
        projectPath={projectPath}
        open={promptOpen}
        onClose={() => setPromptOpen(false)}
      />
    </div>
  );
}

/**
 * Smart failure banner. Inspects the last ~30 stderr lines from the dev
 * server's log to figure out *what actually failed*, then renders:
 *   - a humanized one-liner (port-in-use, ENOENT, etc.) instead of the
 *     hardcoded "your command isn't right" lie
 *   - an auto-fix button if we have a known remediation
 *   - the Reconfigure button as a fallback (always present)
 *
 * The component reads the log live, so if the user clicks Stop and Start
 * again the banner reflects the new failure cause.
 */
function DevServerFailureBanner({
  port,
  onReconfigure,
  onFreePort,
}: {
  port: number | null;
  onReconfigure: () => void;
  onFreePort: ((port: number) => Promise<void>) | null;
}) {
  const log = useDevServerStore((s) => s.log);

  // Scan BOTH streams: Vite prints "error when starting dev server / Port N is
  // already in use" on stdout, not stderr, so an stderr-only scan would miss
  // the very failure we most need to recognise. The user never has to open the
  // Output pane to find out what went wrong — we read the whole log for them.
  const logText = useMemo(
    () =>
      log
        .slice(-40)
        .map((l) => l.line)
        .join("\n"),
    [log],
  );

  const explanation = useMemo(() => humanizeError(logText), [logText]);
  const fix = useMemo(() => findFix(logText), [logText]);
  const [fixing, setFixing] = useState(false);
  const [killing, setKilling] = useState(false);

  const handleFix = async () => {
    if (!fix) return;
    setFixing(true);
    try {
      await runAutoFix(fix);
    } finally {
      setFixing(false);
    }
  };

  const handleKill = async () => {
    if (port == null || !onFreePort) return;
    setKilling(true);
    try {
      await onFreePort(port);
    } finally {
      setKilling(false);
    }
  };

  const portInUse = useMemo(() => isPortInUseError(logText), [logText]);
  const canKill = portInUse && port != null && onFreePort != null;

  return (
    <div className="mx-3 mb-2 flex flex-col gap-2 rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
      <div className="flex items-start gap-2">
        <Lightbulb
          size={12}
          weight="fill"
          className="mt-0.5 shrink-0 text-amber-300/85"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="font-medium text-amber-50">
            {explanation?.title ?? "Dev server failed to start"}
          </div>
          {explanation?.hint && (
            <div className="text-amber-100/75">{explanation.hint}</div>
          )}
          {!explanation && (
            <div className="text-amber-100/75">
              Check the Output pane for details, or try a different command.
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {fix && (
          <button
            type="button"
            onClick={() => void handleFix()}
            disabled={fixing}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-100 hover:border-emerald-300/60 hover:bg-emerald-500/25 disabled:opacity-50"
          >
            <MagicWand size={11} weight="fill" />
            {fixing ? "Running fix…" : `Auto-fix · ${fix.title}`}
          </button>
        )}
        {canKill && (
          <button
            type="button"
            onClick={() => void handleKill()}
            disabled={killing}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-400/40 bg-red-500/15 px-2 py-1 text-[11px] font-medium text-red-100 hover:border-red-300/60 hover:bg-red-500/25 disabled:opacity-50"
          >
            <Plugs size={11} weight="fill" />
            {killing ? "Freeing…" : `Free port ${port} & restart`}
          </button>
        )}
        <button
          onClick={onReconfigure}
          className="inline-flex items-center gap-1 rounded-md border border-amber-300/40 bg-amber-400/15 px-2 py-1 text-[11px] font-medium text-amber-100 hover:bg-amber-400/25"
        >
          <Gear size={11} weight="bold" />
          Reconfigure
        </button>
      </div>
    </div>
  );
}
