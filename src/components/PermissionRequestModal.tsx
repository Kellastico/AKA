import { ShieldWarning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

type PermissionRequest = { id: number; path: string };

const REQUEST_EVT = "permission://request";
const RESPONSE_EVT = "permission://response";

/**
 * Surfaces every Rust-side `permission://request` event. The user always
 * sees the request — never silently allowed, never silently denied. On Allow
 * or Deny we emit `permission://response`; dismissing the modal (escape /
 * backdrop) counts as Deny.
 */
export function PermissionRequestModal() {
  const [request, setRequest] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<PermissionRequest>(REQUEST_EVT, (event) => {
      setRequest(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  function respond(granted: boolean) {
    if (!request) return;
    emit(RESPONSE_EVT, { id: request.id, granted });
    if (!granted) {
      // eslint-disable-next-line no-console
      console.warn(
        `Access denied: ${request.path} is outside the project sandbox.`,
      );
    }
    setRequest(null);
  }

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") respond(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request) return null;

  return (
    <div
      data-testid="permission-request-modal"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => respond(false)}
    >
      <div
        className="w-[420px] max-w-[90vw] rounded-2xl border border-white/15 bg-zinc-900/95 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <ShieldWarning size={20} className="text-amber-300" />
          <h2 className="text-sm font-medium">Access outside project</h2>
        </div>
        <p className="mb-1 text-sm text-white/80">
          The agent is requesting access to
        </p>
        <p className="mb-4 break-all rounded-md border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs text-white/90">
          {request.path}
        </p>
        <p className="mb-4 text-xs text-white/60">
          which is outside your project. Allow? (Granted for this session only —
          never saved.)
        </p>
        <div className="flex justify-end gap-2">
          <button
            data-testid="permission-deny"
            onClick={() => respond(false)}
            className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10"
          >
            Deny
          </button>
          <button
            data-testid="permission-allow"
            onClick={() => respond(true)}
            className="rounded-md bg-amber-400/90 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-300"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
