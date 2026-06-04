import { useEffect, useRef } from "react";
import type { LogLine } from "./use-agent-runner-store";

export function LogView({
  lines,
  empty,
  className = "",
}: {
  lines: LogLine[];
  empty?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={ref}
      className={[
        "h-full w-full overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed",
        className,
      ].join(" ")}
    >
      {lines.length === 0 ? (
        <div className="text-white/30">{empty ?? "No output yet."}</div>
      ) : (
        lines.map((l) => (
          <div
            key={l.id}
            className={
              l.stream === "stderr" ? "text-rose-300/90" : "text-white/85"
            }
          >
            {l.line || " "}
          </div>
        ))
      )}
    </div>
  );
}
