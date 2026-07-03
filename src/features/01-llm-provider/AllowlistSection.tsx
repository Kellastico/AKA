import { useState } from "react";
import { GlobeSimple, Plus, X } from "@phosphor-icons/react";
import { useProjectConfigStore } from "../../stores/use-project-config-store";

/**
 * Editor for the active project's network egress allowlist
 * (`capabilities.network_allowlist` in `.äkä/config.json`). Remote endpoints
 * are deny-by-default (`gate_egress` / `tools::policy::network_egress`);
 * loopback is always allowed. An entry matches an exact host (with or without
 * port) or a full-URL prefix.
 *
 * Lives in the Runtime modal by design — BYOK/runtime settings belong here,
 * not in a general Settings surface (see features/09-settings/Context.md).
 * The backend re-reads the config from disk on every call, so edits apply to
 * the next request without a restart.
 */
export function AllowlistSection() {
  const projectPath = useProjectConfigStore((s) => s.projectPath);
  const entries = useProjectConfigStore(
    (s) => s.config?.capabilities.network_allowlist ?? [],
  );
  const setNetworkAllowlist = useProjectConfigStore((s) => s.setNetworkAllowlist);

  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    setDraft("");
    if (entries.includes(value)) return;
    void setNetworkAllowlist([...entries, value]);
  };

  const remove = (entry: string) => {
    void setNetworkAllowlist(entries.filter((e) => e !== entry));
  };

  return (
    <div className="flex flex-col gap-2 px-1">
      <div className="flex items-center gap-1.5">
        <GlobeSimple size={12} className="text-white/50" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50">
          Network allowlist
        </span>
      </div>

      {!projectPath ? (
        <p className="px-0.5 text-[10px] leading-relaxed text-white/40">
          Open a project to manage its allowlist. Remote endpoints are blocked
          per project until listed here; localhost is always allowed.
        </p>
      ) : (
        <>
          <p className="px-0.5 text-[10px] leading-relaxed text-white/40">
            Remote endpoints are blocked for this project unless listed here
            (localhost is always allowed). Add a host like{" "}
            <code>api.example.com</code> or a URL prefix like{" "}
            <code>https://api.example.com</code>. Changes apply to the next
            call.
          </p>

          {entries.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {entries.map((entry) => (
                <li
                  key={entry}
                  className="group flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/75">
                    {entry}
                  </span>
                  <button
                    onClick={() => remove(entry)}
                    title={`Remove ${entry} — calls to it will be blocked again`}
                    aria-label={`Remove ${entry} from allowlist`}
                    className="shrink-0 rounded p-0.5 text-white/35 transition hover:bg-white/10 hover:text-red-300"
                  >
                    <X size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-0.5 text-[10px] italic text-white/30">
              No entries — all remote egress is blocked.
            </p>
          )}

          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  add();
                }
              }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="api.example.com"
              className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-white outline-none placeholder:text-white/30 focus:border-white/40"
            />
            <button
              onClick={add}
              disabled={!draft.trim()}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white/15 px-2.5 py-1.5 text-[11px] text-white hover:bg-white/25 disabled:opacity-50"
            >
              <Plus size={11} />
              Add
            </button>
          </div>
        </>
      )}
    </div>
  );
}
