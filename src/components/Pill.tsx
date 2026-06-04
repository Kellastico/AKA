import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";

type PillProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  width?: "sm" | "md" | "lg";
  active?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
};

const widthMap = {
  sm: "min-w-[80px] max-w-[140px] px-4",
  md: "max-w-[200px] px-5",
  lg: "min-w-[200px] max-w-[320px] px-6",
};

export const Pill = forwardRef<HTMLButtonElement, PillProps>(
  (
    { width = "md", active, icon, trailing, className = "", children, ...rest },
    ref
  ) => (
    <button
      ref={ref}
      className={[
        "h-10 rounded-2xl text-sm",
        "inline-flex items-center gap-2",
        trailing ? "justify-between" : "justify-center",
        "transition-all",
        active
          ? "border border-white/25 bg-white/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-md"
          : "border border-transparent text-white/70 hover:bg-white/10 hover:text-white active:bg-white/15 active:text-white",
        widthMap[width],
        className,
      ].join(" ")}
      {...rest}
    >
      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      </span>
      {trailing && (
        <span className="inline-flex shrink-0 items-center">{trailing}</span>
      )}
    </button>
  )
);
Pill.displayName = "Pill";
