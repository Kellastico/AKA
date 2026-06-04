import { useRef } from "react";
import { CaretDown, Cube } from "@phosphor-icons/react";
import { Popover } from "../../components/Popover";
import { ConnectionPanel, HealthDot } from "./ConnectionPanel";
import { activeRuntimeName, useRuntimeStore } from "./use-runtime-store";

/**
 * Top-bar runtime control. Owns the runtime settings popover (ConnectionPanel)
 * — selecting/switching the active runtime is a top-level concern, separate
 * from per-message model selection in the chatbox. Open state is held in the
 * runtime store so other surfaces (the model picker's offline links) can open
 * it too.
 */
export function RuntimeButton() {
  const ref = useRef<HTMLButtonElement>(null);
  const open = useRuntimeStore((s) => s.runtimePanelOpen);
  const setOpen = useRuntimeStore((s) => s.setRuntimePanelOpen);
  const healthy = useRuntimeStore((s) => s.healthy);
  const activeName = useRuntimeStore(activeRuntimeName);

  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen(!open)}
        className="inline-flex h-9 max-w-[220px] items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 text-xs text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl transition-colors hover:border-white/30 hover:bg-white/20"
        aria-label={activeName ? `Runtime settings — ${activeName} active` : "Runtime settings"}
      >
        <HealthDot healthy={healthy} size={6} />
        <Cube size={14} className="shrink-0" />
        <span className="shrink-0">Runtime</span>
        {activeName ? (
          <span className="truncate text-white/55">· {activeName}</span>
        ) : null}
        <CaretDown
          size={11}
          weight="bold"
          className={[
            "ml-0.5 shrink-0 text-white/50 transition-transform",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        width={300}
      >
        <ConnectionPanel onDone={() => setOpen(false)} />
      </Popover>
    </>
  );
}
