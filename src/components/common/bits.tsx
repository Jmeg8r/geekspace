import {
  AlignLeft,
  ArrowUpRight,
  Calendar,
  CalendarDays,
  CheckSquare,
  CircleDot,
  Clock,
  Hash,
  Link2,
  List,
  Sigma,
  SquareCheck,
  Table2,
  Tags,
  Type,
  Kanban,
  ChartGantt,
  type LucideIcon,
} from "lucide-react";
import type { PropertyType, ViewType } from "../../../convex/lib/types";
import { chipClass } from "../../lib/optionColors";
import { cn } from "../../lib/utils";

export function Chip({ color, name, className }: { color?: string; name: string; className?: string }) {
  return (
    <span className={cn(chipClass(color), className)}>
      <span>{name}</span>
    </span>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-hov">
        <span
          className="block h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-[12px] tabular-nums text-ink-2">{pct}%</span>
    </span>
  );
}

export const PROP_ICONS: Record<PropertyType, LucideIcon> = {
  title: Type,
  text: AlignLeft,
  number: Hash,
  select: CircleDot,
  multiSelect: Tags,
  status: SquareCheck,
  date: Calendar,
  checkbox: CheckSquare,
  url: Link2,
  relation: ArrowUpRight,
  rollup: Sigma,
  createdTime: Clock,
  updatedTime: Clock,
};

export const PROP_TYPE_LABELS: Record<PropertyType, string> = {
  title: "Title",
  text: "Text",
  number: "Number",
  select: "Select",
  multiSelect: "Multi-select",
  status: "Status",
  date: "Date",
  checkbox: "Checkbox",
  url: "URL",
  relation: "Relation",
  rollup: "Rollup",
  createdTime: "Created time",
  updatedTime: "Updated time",
};

export const VIEW_ICONS: Record<ViewType, LucideIcon> = {
  table: Table2,
  board: Kanban,
  list: List,
  calendar: CalendarDays,
  timeline: ChartGantt,
};

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-border bg-hov px-1.5 py-0.5 font-sans text-[10px] text-ink-2">
      {children}
    </kbd>
  );
}
