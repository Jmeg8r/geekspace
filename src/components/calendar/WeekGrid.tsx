import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { format, isSameDay, startOfWeek } from "date-fns";
import { CircleCheck, Lock, LockOpen, SquarePen, Zap } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { clamp, cn, tzOffsetMin } from "../../lib/utils";
import { fmtTime, epochToCalendarMs } from "../../lib/dates";
import { colorVarClass } from "../../lib/optionColors";
import { ContextMenuOverlay, useContextMenu } from "../common/ContextMenu";

export const HOUR_H = 52;
const SNAP = 15;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

type EventDoc = Doc<"events">;
type BlockItem = Doc<"timeBlocks"> & { taskTitle: string; color: string; done: boolean };

type GridItem =
  | { kind: "event"; id: string; start: number; end: number; data: EventDoc }
  | { kind: "block"; id: string; start: number; end: number; data: BlockItem };

type Drag =
  | { mode: "create"; dayIdx: number; anchorMin: number; startMin: number; endMin: number }
  | { mode: "move"; item: GridItem; dayIdx: number; startMin: number; durMin: number; moved: boolean }
  | { mode: "resize"; item: GridItem; dayIdx: number; startMin: number; endMin: number };

export interface CreateDraft {
  start: number;
  end: number;
}

// WHAT: The week planner grid — fixed events, engine-owned task blocks, locked
// blocks, past-due striping, now line, and full drag interactions
// (create / move / resize) with 15-minute snapping.
export function WeekGrid({
  anchor,
  onCreateEvent,
  onEditEvent,
}: {
  anchor: number;
  onCreateEvent: (draft: CreateDraft) => void;
  onEditEvent: (event: EventDoc) => void;
}) {
  const weekStart = useMemo(() => startOfWeek(anchor).getTime(), [anchor]);
  const weekEnd = weekStart + 7 * DAY_MS;
  const events = useQuery(api.events.listRange, { start: weekStart, end: weekEnd }) ?? [];
  const blocks = useQuery(api.timeBlocks.listRange, { start: weekStart, end: weekEnd }) ?? [];
  const settings = useQuery(api.settings.get);
  const moveEvent = useMutation(api.events.update);
  const moveBlock = useMutation(api.timeBlocks.move);
  const toggleLock = useMutation(api.timeBlocks.toggleLock);
  const updateRowProp = useMutation(api.rows.updateProperty);
  const myTasks = useQuery(api.calendarData.myTasks) ?? [];
  const openRow = useUI((s) => s.openRow);
  const ctx = useContextMenu();

  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [, forceTick] = useState(0);

  // Re-render every 30s so the now-line crawls.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll so 8am is near the top on mount.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 7.5 * HOUR_H });
  }, []);

  const days = Array.from({ length: 7 }, (_, i) => weekStart + i * DAY_MS);
  const now = Date.now();

  const items: GridItem[] = [
    ...events
      .filter((e) => !e.allDay)
      .map((e) => ({ kind: "event" as const, id: e._id, start: e.start, end: e.end, data: e })),
    ...blocks.map((b) => ({ kind: "block" as const, id: b._id, start: b.start, end: b.end, data: b })),
  ];

  function pointToGrid(clientX: number, clientY: number) {
    const rect = gridRef.current!.getBoundingClientRect();
    const dayW = rect.width / 7;
    const dayIdx = clamp(Math.floor((clientX - rect.left) / dayW), 0, 6);
    const rawMin = ((clientY - rect.top) / HOUR_H) * 60;
    const minute = clamp(Math.round(rawMin / SNAP) * SNAP, 0, 24 * 60);
    return { dayIdx, minute };
  }

  function dayMinToMs(dayIdx: number, minute: number): number {
    return days[dayIdx] + minute * MIN_MS;
  }

  // ---------- drag handlers ----------
  function onGridPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || !gridRef.current) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-grid-item]")) return; // item drags handle themselves
    const { dayIdx, minute } = pointToGrid(e.clientX, e.clientY);
    const d: Drag = { mode: "create", dayIdx, anchorMin: minute, startMin: minute, endMin: minute + 30 };
    startPointerDrag(d, e);
  }

  function onItemPointerDown(e: React.PointerEvent, item: GridItem) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Past/started blocks and events are immutable history — no dragging back in time machines.
    if (item.start <= now && item.kind === "block") return;
    const startDate = new Date(item.start);
    const dayIdx = clamp(Math.round((epochToCalendarMs(item.start) - epochToCalendarMs(weekStart)) / DAY_MS), 0, 6);
    const startMin = startDate.getHours() * 60 + startDate.getMinutes();
    const d: Drag = {
      mode: "move",
      item,
      dayIdx,
      startMin,
      durMin: Math.round((item.end - item.start) / MIN_MS),
      moved: false,
    };
    startPointerDrag(d, e);
  }

  function onResizePointerDown(e: React.PointerEvent, item: GridItem) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startDate = new Date(item.start);
    const endDate = new Date(item.end);
    const dayIdx = clamp(Math.round((epochToCalendarMs(item.start) - epochToCalendarMs(weekStart)) / DAY_MS), 0, 6);
    const d: Drag = {
      mode: "resize",
      item,
      dayIdx,
      startMin: startDate.getHours() * 60 + startDate.getMinutes(),
      endMin: endDate.getHours() * 60 + endDate.getMinutes() || 24 * 60,
    };
    startPointerDrag(d, e);
  }

  function startPointerDrag(initial: Drag, _e: React.PointerEvent) {
    const state = { ...initial } as Drag;
    setDrag(state);
    const onMove = (ev: PointerEvent) => {
      if (!gridRef.current) return;
      const { dayIdx, minute } = pointToGrid(ev.clientX, ev.clientY);
      if (state.mode === "create") {
        if (minute >= state.anchorMin + SNAP) {
          state.startMin = state.anchorMin;
          state.endMin = minute;
        } else if (minute <= state.anchorMin - SNAP) {
          state.startMin = minute;
          state.endMin = state.anchorMin;
        } else {
          state.startMin = state.anchorMin;
          state.endMin = state.anchorMin + 30;
        }
        state.dayIdx = dayIdx;
      } else if (state.mode === "move") {
        state.moved = true;
        state.dayIdx = dayIdx;
        state.startMin = clamp(minute - Math.round(state.durMin / 2 / SNAP) * SNAP, 0, 24 * 60 - state.durMin);
      } else {
        state.endMin = clamp(Math.max(minute, state.startMin + SNAP), 0, 24 * 60);
      }
      setDrag({ ...state });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      commitDrag(state);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function commitDrag(d: Drag) {
    if (d.mode === "create") {
      if (d.endMin - d.startMin >= SNAP) {
        onCreateEvent({ start: dayMinToMs(d.dayIdx, d.startMin), end: dayMinToMs(d.dayIdx, d.endMin) });
      }
      return;
    }
    if (d.mode === "move") {
      if (!d.moved) {
        // A clean click: open the right detail surface.
        if (d.item.kind === "event") onEditEvent(d.item.data);
        else openRow(d.item.data.taskRowId);
        return;
      }
      const start = dayMinToMs(d.dayIdx, d.startMin);
      const end = start + d.durMin * MIN_MS;
      if (d.item.kind === "event") {
        void moveEvent({ eventId: d.item.data._id, start, end, tzOffsetMin: tzOffsetMin() });
      } else {
        void moveBlock({ blockId: d.item.data._id, start, end, tzOffsetMin: tzOffsetMin() });
      }
      return;
    }
    // resize
    const start = dayMinToMs(d.dayIdx, d.startMin);
    const end = dayMinToMs(d.dayIdx, d.endMin);
    if (d.item.kind === "event") {
      void moveEvent({ eventId: d.item.data._id, start, end, tzOffsetMin: tzOffsetMin() });
    } else {
      void moveBlock({ blockId: d.item.data._id, start, end, tzOffsetMin: tzOffsetMin() });
    }
  }

  function blockContextMenu(e: React.MouseEvent, b: BlockItem) {
    const task = myTasks.find((t) => t.rowId === b.taskRowId);
    ctx.open(e, [
      {
        icon: b.locked ? LockOpen : Lock,
        label: b.locked ? "Unlock (let engine move it)" : "Lock in place",
        onClick: () => void toggleLock({ blockId: b._id, tzOffsetMin: tzOffsetMin() }),
      },
      ...(task?.completeOptionId
        ? [
            {
              icon: CircleCheck,
              label: "Mark task done",
              onClick: () =>
                void updateRowProp({
                  rowId: b.taskRowId,
                  propId: task.statusPropId,
                  value: task.completeOptionId,
                  tzOffsetMin: tzOffsetMin(),
                }),
            },
          ]
        : []),
      { icon: SquarePen, label: "Open task", onClick: () => openRow(b.taskRowId) },
    ]);
  }

  // ---------- layout ----------
  const workStart = settings?.dayStartMin ?? 540;
  const workEnd = settings?.dayEndMin ?? 1080;
  const workDays = settings?.workDays ?? [1, 2, 3, 4, 5];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers + all-day lane */}
      <div className="flex border-b border-border pr-2">
        <div className="w-14 shrink-0" />
        {days.map((day) => {
          const isToday = isSameDay(day, now);
          return (
            <div key={day} className="flex-1 px-1.5 pb-1.5 pt-1">
              <div className="flex items-baseline gap-1.5">
                <span className={cn("text-[11px] font-semibold uppercase", isToday ? "text-accent" : "text-ink-3")}>
                  {format(day, "EEE")}
                </span>
                <span
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-[13px] font-semibold",
                    isToday ? "bg-accent text-white" : "text-ink"
                  )}
                >
                  {format(day, "d")}
                </span>
              </div>
              <AllDayLane day={day} events={events} />
            </div>
          );
        })}
      </div>

      {/* Scrollable time grid */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex">
          {/* Hour gutter */}
          <div className="relative w-14 shrink-0" style={{ height: 24 * HOUR_H }}>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[10.5px] text-ink-3"
                style={{ top: h * HOUR_H }}
              >
                {h % 12 === 0 ? 12 : h % 12} {h < 12 ? "AM" : "PM"}
              </span>
            ))}
          </div>

          {/* Grid */}
          <div
            ref={gridRef}
            onPointerDown={onGridPointerDown}
            className="relative flex-1 cursor-crosshair select-none"
            style={{ height: 24 * HOUR_H }}
          >
            {/* hour lines */}
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute left-0 right-0 border-t border-border/70" style={{ top: h * HOUR_H }} />
            ))}
            {/* day columns + working hours shading */}
            {days.map((day, i) => {
              const working = workDays.includes(new Date(day).getDay());
              return (
                <div
                  key={day}
                  className="absolute bottom-0 top-0 border-l border-border/70"
                  style={{ left: `${(i / 7) * 100}%`, width: `${100 / 7}%` }}
                >
                  {working ? (
                    <>
                      <div className="absolute left-0 right-0 top-0 bg-[color-mix(in_srgb,var(--hover)_55%,transparent)]" style={{ height: (workStart / 60) * HOUR_H }} />
                      <div className="absolute bottom-0 left-0 right-0 bg-[color-mix(in_srgb,var(--hover)_55%,transparent)]" style={{ top: (workEnd / 60) * HOUR_H }} />
                    </>
                  ) : (
                    <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--hover)_55%,transparent)]" />
                  )}
                </div>
              );
            })}

            {/* items per day with overlap layout */}
            {days.map((day, dayIdx) => (
              <DayItems
                key={day}
                day={day}
                dayIdx={dayIdx}
                items={items}
                now={now}
                drag={drag}
                onItemPointerDown={onItemPointerDown}
                onResizePointerDown={onResizePointerDown}
                onBlockContextMenu={blockContextMenu}
              />
            ))}

            {/* create-drag preview */}
            {drag?.mode === "create" && (
              <div
                className="pointer-events-none absolute rounded-md border-2 border-accent bg-accent-soft"
                style={{
                  left: `calc(${(drag.dayIdx / 7) * 100}% + 2px)`,
                  width: `calc(${100 / 7}% - 5px)`,
                  top: (drag.startMin / 60) * HOUR_H,
                  height: Math.max(((drag.endMin - drag.startMin) / 60) * HOUR_H, 12),
                }}
              >
                <span className="px-1.5 text-[11px] font-medium text-accent">
                  {fmtTime(dayMinToMs(drag.dayIdx, drag.startMin))} – {fmtTime(dayMinToMs(drag.dayIdx, drag.endMin))}
                </span>
              </div>
            )}

            {/* now line */}
            {days.some((d) => isSameDay(d, now)) && <NowLine days={days} now={now} />}
          </div>
        </div>
      </div>
      <ContextMenuOverlay menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}

function AllDayLane({ day, events }: { day: number; events: EventDoc[] }) {
  const dayEnd = day + DAY_MS;
  const allDay = events.filter((e) => e.allDay && e.start < dayEnd && e.end > day);
  const dueItems = useQuery(api.calendarData.listForCalendar) ?? [];
  const dayCal = epochToCalendarMs(day + DAY_MS / 2);
  const due = dueItems.filter((it) => {
    const startDay = it.date.includeTime ? epochToCalendarMs(it.date.start) : it.date.start;
    const endDay = it.date.end !== undefined ? (it.date.includeTime ? epochToCalendarMs(it.date.end) : it.date.end) : startDay;
    return dayCal >= startDay && dayCal <= endDay;
  });
  const openRow = useUI((s) => s.openRow);

  return (
    <div className="mt-1 flex min-h-[18px] flex-col gap-0.5">
      {allDay.slice(0, 2).map((e) => (
        <span key={e._id} className={cn("evt truncate rounded px-1.5 text-[10.5px] font-medium", colorVarClass(e.color))}>
          {e.title}
        </span>
      ))}
      {due.slice(0, 2).map((it) => (
        <button
          key={it.rowId}
          onClick={() => openRow(it.rowId)}
          className={cn(
            "truncate rounded border border-border px-1.5 text-left text-[10.5px] text-ink-2 hover:bg-hov",
            it.done && "line-through opacity-60"
          )}
          title={`Due: ${it.title}`}
        >
          ⚑ {it.title}
        </button>
      ))}
    </div>
  );
}

function NowLine({ days, now }: { days: number[]; now: number }) {
  const todayIdx = days.findIndex((d) => isSameDay(d, now));
  const d = new Date(now);
  const min = d.getHours() * 60 + d.getMinutes();
  return (
    <>
      <div
        className="pointer-events-none absolute left-0 right-0 h-px opacity-30 now-line"
        style={{ top: (min / 60) * HOUR_H }}
      />
      <div
        className="now-line pointer-events-none absolute h-[2px]"
        style={{
          top: (min / 60) * HOUR_H,
          left: `${(todayIdx / 7) * 100}%`,
          width: `${100 / 7}%`,
        }}
      />
    </>
  );
}

/** Greedy interval-graph column assignment so overlapping items sit side by side. */
function layoutDay(items: GridItem[]): Array<{ item: GridItem; col: number; cols: number }> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const colEnds: number[] = [];
  const placed = sorted.map((item) => {
    let col = colEnds.findIndex((end) => end <= item.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(item.end);
    } else {
      colEnds[col] = item.end;
    }
    return { item, col, cols: 1 };
  });
  const total = colEnds.length || 1;
  return placed.map((p) => ({ ...p, cols: total }));
}

function DayItems({
  day,
  dayIdx,
  items,
  now,
  drag,
  onItemPointerDown,
  onResizePointerDown,
  onBlockContextMenu,
}: {
  day: number;
  dayIdx: number;
  items: GridItem[];
  now: number;
  drag: Drag | null;
  onItemPointerDown: (e: React.PointerEvent, item: GridItem) => void;
  onResizePointerDown: (e: React.PointerEvent, item: GridItem) => void;
  onBlockContextMenu: (e: React.MouseEvent, b: BlockItem) => void;
}) {
  const dayEnd = day + DAY_MS;
  const dayItems = items.filter((it) => it.start < dayEnd && it.end > day);
  const laidOut = layoutDay(dayItems);

  return (
    <>
      {laidOut.map(({ item, col, cols }) => {
        const isDragged =
          drag && drag.mode !== "create" && drag.item.id === item.id;
        let start = item.start;
        let end = item.end;
        if (isDragged && drag.mode === "move" && drag.moved) {
          start = day + drag.startMin * MIN_MS; // visual only; day comes from drag.dayIdx
          end = start + drag.durMin * MIN_MS;
          if (drag.dayIdx !== dayIdx) return null;
        } else if (isDragged && drag.mode === "resize") {
          end = day + drag.endMin * MIN_MS;
        }
        const startMin = Math.max(0, (start - day) / MIN_MS);
        const endMin = Math.min(24 * 60, (end - day) / MIN_MS);
        if (endMin <= startMin) return null;

        const width = 100 / 7 / cols;
        const left = (dayIdx / 7) * 100 + col * width;
        const isPast = item.end < now;

        const common = {
          "data-grid-item": true,
          onPointerDown: (e: React.PointerEvent) => onItemPointerDown(e, item),
          style: {
            left: `calc(${left}% + 2px)`,
            width: `calc(${width}% - 5px)`,
            top: (startMin / 60) * HOUR_H + 1,
            height: Math.max(((endMin - startMin) / 60) * HOUR_H - 2, 14),
            zIndex: isDragged ? 40 : item.kind === "event" ? 20 : 15,
          } as React.CSSProperties,
        };

        if (item.kind === "event") {
          const e = item.data;
          return (
            <div
              key={item.id}
              {...common}
              className={cn(
                "evt group absolute cursor-grab overflow-hidden rounded-md px-1.5 py-0.5",
                colorVarClass(e.color),
                isPast && "opacity-60",
                isDragged && "cursor-grabbing shadow-lg"
              )}
            >
              <div className="truncate text-[11.5px] font-semibold leading-tight">{e.title || "Untitled"}</div>
              <div className="truncate text-[10.5px] opacity-90">
                {fmtTime(start)} – {fmtTime(end)}
              </div>
              <span
                className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize"
                onPointerDown={(ev) => onResizePointerDown(ev, item)}
              />
            </div>
          );
        }

        const b = item.data;
        return (
          <div
            key={item.id}
            {...common}
            onContextMenu={(e) => onBlockContextMenu(e, b)}
            className={cn(
              "task-block group absolute overflow-hidden rounded-md px-1.5 py-0.5",
              colorVarClass(b.color),
              b.locked && "locked",
              b.pastDue && "past-due",
              b.done && "done",
              isPast && "opacity-60",
              item.start > now ? "cursor-grab" : "cursor-pointer",
              isDragged && "cursor-grabbing shadow-lg"
            )}
            title={`${b.taskTitle} • auto-scheduled${b.locked ? " (locked)" : ""}`}
          >
            <div className="flex items-start gap-1">
              <span className="tb-title flex-1 truncate text-[11.5px] font-semibold leading-tight">
                {b.taskTitle}
              </span>
              {b.locked ? (
                <Lock size={10} className="mt-0.5 shrink-0 opacity-80" />
              ) : (
                <Zap size={10} className="mt-0.5 shrink-0 opacity-70" />
              )}
            </div>
            <div className="truncate text-[10.5px] opacity-80">
              {fmtTime(start)} – {fmtTime(end)}
            </div>
            {item.start > now && (
              <span
                className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize"
                onPointerDown={(ev) => onResizePointerDown(ev, item)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
