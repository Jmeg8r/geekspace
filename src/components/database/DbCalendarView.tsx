import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useMutation } from "convex/react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { DateValue, PropertyDef } from "../../../convex/lib/types";
import type { RowDoc } from "../../lib/viewLogic";
import { epochToCalendarMs, todayCalendarMs } from "../../lib/dates";
import { cn, tzOffsetMin } from "../../lib/utils";
import { colorVarClass } from "../../lib/optionColors";
import { useUI } from "../../state/ui";
import type { ViewProps } from "./DatabaseContainer";

const DAY_MS = 86_400_000;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// WHAT: Month-grid calendar view for a database, keyed to one date property.
// Drag an item to another day to write the new date back.
export function DbCalendarView({ db, view, rows }: ViewProps) {
  const props = db.properties as PropertyDef[];
  const dateProp = props.find((p) => p.id === view.datePropId) ?? props.find((p) => p.type === "date");
  const updateRow = useMutation(api.rows.updateProperty);
  const createRow = useMutation(api.rows.create);
  const openRow = useUI((s) => s.openRow);
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const t = new Date();
    return Date.UTC(t.getFullYear(), t.getMonth(), 1);
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const { cells, monthLabel } = useMemo(() => {
    const d = new Date(monthAnchor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const first = Date.UTC(year, month, 1);
    const firstWeekday = new Date(first).getUTCDay();
    const gridStart = first - firstWeekday * DAY_MS;
    const cells = Array.from({ length: 42 }, (_, i) => gridStart + i * DAY_MS);
    return { cells, monthLabel: `${MONTH_NAMES[month]} ${year}` };
  }, [monthAnchor]);

  if (!dateProp) {
    return (
      <div className="px-8 py-10 text-[13px] text-ink-3">
        Add a <b>date</b> property to use the calendar view.
      </div>
    );
  }

  const itemsByDay = new Map<number, RowDoc[]>();
  for (const row of rows) {
    const dv = row.properties?.[dateProp.id] as DateValue | undefined;
    if (!dv) continue;
    const startDay = dv.includeTime ? epochToCalendarMs(dv.start) : dv.start;
    const endDay = dv.end !== undefined ? (dv.includeTime ? epochToCalendarMs(dv.end) : dv.end) : startDay;
    for (let day = startDay; day <= endDay; day += DAY_MS) {
      const list = itemsByDay.get(day) ?? [];
      list.push(row);
      itemsByDay.set(day, list);
    }
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const rowId = e.active.id as string;
    const day = e.over?.id ? Number(e.over.id) : undefined;
    if (!day) return;
    const row = rows.find((r) => r._id === rowId);
    const dv = row?.properties?.[dateProp!.id] as DateValue | undefined;
    if (!row || !dv) return;
    // Shift the whole value, preserving duration and time-of-day.
    if (dv.includeTime) {
      const delta = day - epochToCalendarMs(dv.start);
      void updateRow({
        rowId: row._id,
        propId: dateProp!.id,
        value: { ...dv, start: dv.start + delta, end: dv.end !== undefined ? dv.end + delta : undefined },
        tzOffsetMin: tzOffsetMin(),
      });
    } else {
      const span = dv.end !== undefined ? dv.end - dv.start : 0;
      void updateRow({
        rowId: row._id,
        propId: dateProp!.id,
        value: { ...dv, start: day, end: span ? day + span : undefined },
        tzOffsetMin: tzOffsetMin(),
      });
    }
  }

  const today = todayCalendarMs();
  const viewMonth = new Date(monthAnchor).getUTCMonth();
  const activeRow = activeId ? rows.find((r) => r._id === activeId) : null;

  return (
    <DndContext sensors={sensors} onDragStart={(e) => setActiveId(e.active.id as string)} onDragEnd={onDragEnd}>
      <div className="flex h-full flex-col px-8 py-3">
        <div className="flex items-center gap-2 pb-2">
          <span className="text-[15px] font-bold">{monthLabel}</span>
          <span className="flex-1" />
          <button
            onClick={() => {
              const t = new Date();
              setMonthAnchor(Date.UTC(t.getFullYear(), t.getMonth(), 1));
            }}
            className="rounded-md border border-border px-2 py-0.5 text-[12px] text-ink-2 hover:bg-hov"
          >
            Today
          </button>
          <button
            onClick={() => {
              const d = new Date(monthAnchor);
              setMonthAnchor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
            }}
            className="rounded-md p-1 text-ink-2 hover:bg-hov"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            onClick={() => {
              const d = new Date(monthAnchor);
              setMonthAnchor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
            }}
            className="rounded-md p-1 text-ink-2 hover:bg-hov"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        <div className="grid grid-cols-7 border-b border-l border-t border-border">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="border-r border-border px-2 py-1 text-[11px] font-semibold text-ink-3">
              {d}
            </div>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 border-l border-border">
          {cells.map((day) => (
            <DayCell
              key={day}
              day={day}
              isToday={day === today}
              inMonth={new Date(day).getUTCMonth() === viewMonth}
              items={itemsByDay.get(day) ?? []}
              dbColor={db.color}
              onOpen={openRow}
              onCreate={() =>
                void createRow({
                  databaseId: db._id,
                  properties: { [dateProp!.id]: { start: day } },
                  tzOffsetMin: tzOffsetMin(),
                })
              }
            />
          ))}
        </div>
      </div>
      <DragOverlay>
        {activeRow && (
          <div className={cn("evt rounded px-1.5 py-0.5 text-[11.5px] font-medium", colorVarClass(db.color))}>
            {activeRow.title || "Untitled"}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function DayCell({
  day,
  isToday,
  inMonth,
  items,
  dbColor,
  onOpen,
  onCreate,
}: {
  day: number;
  isToday: boolean;
  inMonth: boolean;
  items: RowDoc[];
  dbColor?: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: String(day) });
  const shown = items.slice(0, 3);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group/day relative flex min-h-[88px] flex-col gap-0.5 border-b border-r border-border p-1",
        !inMonth && "bg-[color-mix(in_srgb,var(--hover)_40%,transparent)]",
        isOver && "bg-accent-soft"
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
            isToday ? "bg-accent font-bold text-white" : inMonth ? "text-ink-2" : "text-ink-3"
          )}
        >
          {new Date(day).getUTCDate()}
        </span>
        <button
          onClick={onCreate}
          className="rounded p-0.5 text-ink-3 opacity-0 hover:bg-hov group-hover/day:opacity-100"
          title="Add item"
        >
          <Plus size={12} />
        </button>
      </div>
      {shown.map((row) => (
        <CalendarPill key={row._id} row={row} color={dbColor} onOpen={onOpen} />
      ))}
      {items.length > 3 && (
        <span className="px-1 text-[10.5px] text-ink-3">+{items.length - 3} more</span>
      )}
    </div>
  );
}

function CalendarPill({
  row,
  color,
  onOpen,
}: {
  row: RowDoc;
  color?: string;
  onOpen: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row._id });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => !isDragging && onOpen(row._id)}
      className={cn(
        "evt w-full truncate rounded px-1.5 py-0.5 text-left text-[11.5px] font-medium",
        colorVarClass(color),
        isDragging && "opacity-30"
      )}
    >
      {row.title || "Untitled"}
    </button>
  );
}
