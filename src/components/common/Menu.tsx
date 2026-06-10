import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function MenuList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("p-1", className)}>{children}</div>;
}

export function MenuItem({
  icon: Icon,
  label,
  hint,
  danger,
  active,
  onClick,
}: {
  icon?: LucideIcon;
  label: ReactNode;
  hint?: string;
  danger?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
        danger ? "text-[var(--pal-red)] hover:bg-[color-mix(in_srgb,var(--pal-red)_10%,transparent)]" : "text-ink hover:bg-hov",
        active && "bg-hov"
      )}
    >
      {Icon && <Icon size={15} className={danger ? "" : "text-ink-2"} />}
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
      {children}
    </div>
  );
}
