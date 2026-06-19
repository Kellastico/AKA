import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Per-element Tailwind classes for ReactMarkdown so assistant responses get
 * proper heading hierarchy, list spacing, code styling, etc. Mirrors what
 * @tailwindcss/typography would give us — kept inline so we don't pull in
 * the plugin just for chat bubbles.
 *
 * All assistant body text — including headings — uses Space Mono (the
 * `--font-mono` token) so the chat reads as an agentic-coder surface, not a
 * generic chat app. Hierarchy is conveyed through size + weight, not typeface.
 */
const MD_COMPONENTS = {
  h1: ({ ...p }) => (
    <h1
      className="mt-4 mb-2 font-mono text-[22px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h2: ({ ...p }) => (
    <h2
      className="mt-3.5 mb-2 font-mono text-[19px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h3: ({ ...p }) => (
    <h3
      className="mt-3 mb-1.5 font-mono text-[16px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h4: ({ ...p }) => (
    <h4
      className="mt-2.5 mb-1 font-mono text-[14px] font-bold tracking-tight text-ink"
      {...p}
    />
  ),
  h5: ({ ...p }) => (
    <h5
      className="mt-2 mb-1 font-mono text-[12px] font-bold uppercase tracking-wider text-ink/85"
      {...p}
    />
  ),
  h6: ({ ...p }) => (
    <h6
      className="mt-2 mb-1 font-mono text-[11px] font-bold uppercase tracking-wider text-ink/70"
      {...p}
    />
  ),
  p: ({ ...p }) => (
    <p className="my-1.5 font-mono text-[13px] leading-relaxed text-ink/90" {...p} />
  ),
  strong: ({ ...p }) => <strong className="font-semibold text-ink" {...p} />,
  em: ({ ...p }) => <em className="text-ink/85" {...p} />,
  a: ({ ...p }) => (
    <a
      className="text-blue-300 underline-offset-2 hover:text-blue-200"
      target="_blank"
      rel="noreferrer"
      {...p}
    />
  ),
  ul: ({ ...p }) => (
    <ul
      className="my-1.5 ml-5 list-disc space-y-0.5 font-mono text-[13px] marker:text-ink/40"
      {...p}
    />
  ),
  ol: ({ ...p }) => (
    <ol
      className="my-1.5 ml-5 list-decimal space-y-0.5 font-mono text-[13px] marker:text-ink/40"
      {...p}
    />
  ),
  li: ({ ...p }) => <li className="text-ink/90" {...p} />,
  blockquote: ({ ...p }) => (
    <blockquote
      className="my-2 border-l-2 border-white/20 pl-3 italic text-ink/70"
      {...p}
    />
  ),
  hr: ({ ...p }) => <hr className="my-3 border-white/10" {...p} />,
  code: ({
    inline,
    className,
    children,
    ...p
  }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  }) => {
    if (inline) {
      return (
        <code
          className="rounded bg-white/8 px-1 py-0.5 font-mono text-[12.5px] text-ink"
          {...p}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={`${className ?? ""} font-mono text-[12px]`} {...p}>
        {children}
      </code>
    );
  },
  pre: ({ ...p }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 text-[12px] text-ink/90"
      {...p}
    />
  ),
  table: ({ ...p }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-left text-[13px] text-ink/85" {...p} />
    </div>
  ),
  th: ({ ...p }) => (
    <th className="border border-white/10 bg-white/5 px-2 py-1 font-medium" {...p} />
  ),
  td: ({ ...p }) => <td className="border border-white/10 px-2 py-1" {...p} />,
};

/** Render agent/assistant markdown with AKA's chat typography. */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
