import { useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useUI } from "../../state/ui";
import { api } from "../../../convex/_generated/api";
import type { DateValue, PropertyDef } from "../../../convex/lib/types";
import type { RowDoc } from "../../lib/viewLogic";
import { epochToCalendarMs, todayCalendarMs } from "../../lib/dates";
import { cn, tzOffsetMin } from "../../lib/utils";
import { colorVarClass } from "../../lib/optionColors";
import type { ViewProps } from "./DatabaseContainer";

const DAY_MS = 86_400_000;
const DAY_W = 38;
const ROW_H = 36;
const RANGE_DAYS = 56; // 8 weeks
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

interface DragState {
  rowId: string;
  mode: "move" | "resize";
  startX: number;
  deltaDays: number;
  orig: { startDay: number; endDay: number };
}

// WHAT: Gantt-style timeline. Drag a bar to shift its dates; drag the right
// edge to change the end date. Writes back to the date property.
export function TimelineView({ db, view, rows }: ViewProps) {
  const props = db.properties as PropertyDef[];
  const dateProp = props.find((p) => p.id === view.datePropId) ?? props.find((p) => p.type === "date");
  const updateRow = useMutation(api.rows.updateProperty);
  const openRow = useUI((s) => s.openRow);
  const [drag, setDrag] = useState<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const today = todayCalendarMs();
  const rangeStart = useMemo(() => {
    const d = new Date(today);
    const weekday = d.getUTCDay();
    return today - weekday * DAY_MS - 7 * DAY_MS;
  }, [today]);

  if (!dateProp) {
    return (
      <div className="px-8 py-10 text-[13px] text-ink-3">
        Add a <b>date</b> property to use the timeline view.
      </div>
    );
  }

  const days = Array.from({ length: RANGE_DAYS }, (_, i) => rangeStart + i * DAY_MS);
  const scheduled: Array<{ row: RowDoc; startDay: number; endDay: number }> = [];
  const unscheduled: RowDoc[] = [];
  for (const row of rows) {
    const dv = row.properties?.[dateProp.id] as DateValue | undefined;
    if (!dv) {
      unscheduled.push(row);
      continue;
    }
    const startDay = dv.includeTime ? epochToCalendarMs(dv.start) : dv.start;
    const endDay = dv.end !== undefined ? (dv.includeTime ? epochToCalendarMs(dv.end) : dv.end) : startDay;
    scheduled.push({ row, startDay, endDay });
  }
  scheduled.sort((a, b) => a.startDay - b.startDay || a.row.order - b.row.order);

  // Dependency arrows (Blocked by): blocker bar end → blocked bar start.
  const blockedByPropId = db.taskConfig?.blockedByPropId;
  const barPos = new Map<string, { idx: number; startDay: number; endDay: number }>();
  scheduled.forEach((s, idx) => barPos.set(s.row._id, { idx, startDay: s.startDay, endDay: s.endDay }));
  const arrows: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
  if (blockedByPropId) {
    for (const s of scheduled) {
      const blockers = s.row.properties?.[blockedByPropId];
      if (!Array.isArray(blockers)) continue;
      for (const b of blockers as string[]) {
        const from = barPos.get(b);
        const to = barPos.get(s.row._id);
        if (!from || !to) continue;
        arrows.push({
          key: `${b}->${s.row._id}`,
          x1: ((from.endDay - rangeStart) / DAY_MS + 1) * DAY_W - 4,
          y1: from.idx * ROW_H + ROW_H / 2 + 1,
          x2: ((to.startDay - rangeStart) / DAY_MS) * DAY_W + 1,
          y2: to.idx * ROW_H + ROW_H / 2 + 1,
        });
      }
    }
  }

  function commitDrag(d: DragState) {
    const { orig, deltaDays, mode, rowId } = d;
    if (deltaDays === 0) return;
    const row = rows.find((r) => r._id === rowId);
    const dv = row?.properties?.[dateProp!.id] as DateValue | undefined;
    if (!row || !dv) return;
    if (mode === "move") {
      const shift = deltaDays * DAY_MS;
      const value: DateValue = dv.includeTime
        ? { ...dv, start: dv.start + shift, end: dv.end !== undefined ? dv.end + shift : undefined }
        : { ...dv, start: dv.start + shift, end: dv.end !== undefined ? dv.end + shift : undefined };
      void updateRow({ rowId: row._id, propId: dateProp!.id, value, tzOffsetMin: tzOffsetMin() });
    } else {
      const newEndDay = Math.max(orig.startDay, orig.endDay + deltaDays * DAY_MS);
      const value: DateValue = dv.includeTime
        ? { ...dv, end: newEndDay === orig.startDay ? undefined : (dv.end ?? dv.start) + (newEndDay - orig.endDay) }
        : { ...dv, end: newEndDay === orig.startDay ? undefined : newEndDay };
      void updateRow({ rowId: row._id, propId: dateProp!.id, value, tzOffsetMin: tzOffsetMin() });
    }
  }

  function startDrag(e: React.PointerEvent, rowId: string, mode: DragState["mode"], orig: DragState["orig"]) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const state: DragState = { rowId, mode, startX, deltaDays: 0, orig };
    setDrag(state);
    const onMove = (ev: PointerEvent) => {
      state.deltaDays = Math.round((ev.clientX - startX) / DAY_W);
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

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-8 py-3">
        <div style={{ width: RANGE_DAYS * DAY_W }}>
          {/* Month + day header */}
          <div className="flex">
            {days.map((day) => {
              const d = new Date(day);
              const first = d.getUTCDate() === 1 || day === rangeStart;
              return (
                <div key={day} className="shrink-0 text-[10.5px] font-semibold text-ink-3" style={{ width: DAY_W }}>
                  {first ? `${MONTHS[d.getUTCMonth()]}` : " "}
                </div>
              );
            })}
          </div>
          <div className="flex border-b border-border pb-1">
            {days.map((day) => {
              const d = new Date(day);
              const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
              return (
                <div
                  key={day}
                  className={cn(
                    "shrink-0 text-center text-[11px]",
                    day === today
                      ? "font-bold text-accent"
                      : weekend
                        ? "text-ink-3"
                        : "text-ink-2"
                  )}
                  style={{ width: DAY_W }}
                >
                  {d.getUTCDate()}
                </div>
              );
            })}
          </div>

          {/* Bars */}
          <div className="relative" style={{ height: Math.max(scheduled.length, 1) * ROW_H + 12 }}>
            {/* weekend + today shading */}
            {days.map((day, i) => {
              const d = new Date(day);
              const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
              return (
                <div
                  key={day}
                  className={cn(
                    "absolute bottom-0 top-0",
                    weekend && "bg-[color-mix(in_srgb,var(--hover)_50%,transparent)]",
                    day === today && "border-l-2 border-accent"
                  )}
                  style={{ left: i * DAY_W, width: DAY_W }}
                />
              );
            })}
            {scheduled.map(({ row, startDay, endDay }, i) => {
              const isDragging = drag?.rowId === row._id;
              const dShift = isDragging && drag!.mode === "move" ? drag!.deltaDays : 0;
              const dResize = isDragging && drag!.mode === "resize" ? drag!.deltaDays : 0;
              const s = startDay + dShift * DAY_MS;
              const e = Math.max(s, endDay + (dShift + dResize) * DAY_MS);
              const left = ((s - rangeStart) / DAY_MS) * DAY_W;
              const width = ((e - s) / DAY_MS + 1) * DAY_W - 6;
              return (
                <div
                  key={row._id}
                  className={cn(
                    "evt group absolute flex cursor-grab items-center rounded-md px-2 text-[12px] font-medium",
                    colorVarClass(db.color),
                    isDragging && "cursor-grabbing opacity-80"
                  )}
                  style={{ left, width: Math.max(width, DAY_W - 6), top: i * ROW_H + 6, height: ROW_H - 10 }}
                  onPointerDown={(ev) => startDrag(ev, row._id, "move", { startDay, endDay })}
                  onClick={() => !drag && openRow(row._id)}
                >
                  <span className="truncate">{row.title || "Untitled"}</span>
                  <span
                    className="absolute -right-0.5 top-0 h-full w-2.5 cursor-ew-resize rounded-r-md opacity-0 group-hover:opacity-100 group-hover:bg-white/30"
                    onPointerDown={(ev) => startDrag(ev, row._id, "resize", { startDay, endDay })}
                  />
                </div>
              );
            })}
            {scheduled.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-3">
                Nothing scheduled in this range
              </div>
            )}
            {arrows.length > 0 && (
              <svg
                className="pointer-events-none absolute inset-0"
                width={RANGE_DAYS * DAY_W}
                height={Math.max(scheduled.length, 1) * ROW_H + 12}
              >
                <defs>
                  <marker id="dep-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                    <path d="M0,0 L7,3.5 L0,7 z" fill="var(--ink-3)" />
                  </marker>
                </defs>
                {arrows.map((a) => (
                  <path
                    key={a.key}
                    d={`M ${a.x1} ${a.y1} C ${a.x1 + 26} ${a.y1}, ${a.x2 - 26} ${a.y2}, ${a.x2 - 2} ${a.y2}`}
                    fill="none"
                    stroke="var(--ink-3)"
                    strokeWidth="1.5"
                    opacity="0.75"
                    markerEnd="url(#dep-arrow)"
                  />
                ))}
              </svg>
            )}
          </div>
        </div>
      </div>

      {unscheduled.length > 0 && (
        <div className="border-t border-border px-8 py-2">
          <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            No date ({unscheduled.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {unscheduled.slice(0, 8).map((row) => (
              <button
                key={row._id}
                onClick={() =>
                  void updateRow({
                    rowId: row._id,
                    propId: dateProp.id,
                    value: { start: today },
                    tzOffsetMin: tzOffsetMin(),
                  })
                }
                className="rounded-md border border-border px-2 py-0.5 text-[12px] text-ink-2 hover:bg-hov"
                title="Schedule for today"
              >
                {row.title || "Untitled"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
