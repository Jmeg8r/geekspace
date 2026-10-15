import { useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
const WEEK_MS = 7 * DAY_MS;
// Sticky title column, so every bar can be read even when it is one day wide.
const LABEL_W = 200;
// Rough width of one 12px Inter character plus the bar padding, to decide whether a title
// fits inside its bar or goes beside it.
const TITLE_CHAR_W = 6.5;
const BAR_PADDING_W = 16;
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
  // Weeks the window is moved from its default (one week before this one).
  const [weekOffset, setWeekOffset] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const today = todayCalendarMs();
  const rangeStart = useMemo(() => {
    const d = new Date(today);
    const weekday = d.getUTCDay();
    return today - weekday * DAY_MS - WEEK_MS + weekOffset * WEEK_MS;
  }, [today, weekOffset]);
  const rangeEnd = rangeStart + (RANGE_DAYS - 1) * DAY_MS;

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
  // Rows dated wholly outside the window used to be drawn off the grid: invisible, yet still
  // taking a row. They are counted instead, with a way to bring them into view.
  const earlier = scheduled.filter((s) => s.endDay < rangeStart);
  const later = scheduled.filter((s) => s.startDay > rangeEnd);
  const visible = scheduled.filter((s) => s.endDay >= rangeStart && s.startDay <= rangeEnd);
  const weeksUntil = (day: number) => Math.floor((day - rangeStart) / WEEK_MS);

  // Dependency arrows (Blocked by): blocker bar end → blocked bar start.
  const blockedByPropId = db.taskConfig?.blockedByPropId;
  const barPos = new Map<string, { idx: number; startDay: number; endDay: number }>();
  visible.forEach((s, idx) => barPos.set(s.row._id, { idx, startDay: s.startDay, endDay: s.endDay }));
  const arrows: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
  if (blockedByPropId) {
    for (const s of visible) {
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

  const trackW = RANGE_DAYS * DAY_W;
  const bodyH = Math.max(visible.length, 1) * ROW_H + 12;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-8 pt-2 text-[12px]">
        <button
          onClick={() => setWeekOffset((w) => w - 1)}
          className="rounded-md p-1 text-ink-2 hover:bg-hov"
          title="Previous week"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          onClick={() => setWeekOffset(0)}
          className="rounded-md px-2 py-0.5 text-ink-2 hover:bg-hov"
        >
          Today
        </button>
        <button
          onClick={() => setWeekOffset((w) => w + 1)}
          className="rounded-md p-1 text-ink-2 hover:bg-hov"
          title="Next week"
        >
          <ChevronRight size={14} />
        </button>
        {earlier.length > 0 && (
          <button
            onClick={() => setWeekOffset((w) => w + weeksUntil(earlier[earlier.length - 1].startDay))}
            className="rounded-md border border-border px-2 py-0.5 text-ink-2 hover:bg-hov"
          >
            ← {earlier.length} earlier
          </button>
        )}
        {later.length > 0 && (
          <button
            onClick={() => setWeekOffset((w) => w + weeksUntil(later[0].startDay))}
            className="rounded-md border border-border px-2 py-0.5 text-ink-2 hover:bg-hov"
          >
            {later.length} later →
          </button>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-8 py-3">
        <div style={{ width: LABEL_W + trackW }}>
          {/* Month + day header */}
          <div className="flex">
            <div className="sticky left-0 z-10 shrink-0 bg-bg" style={{ width: LABEL_W }} />
            {days.map((day) => {
              const d = new Date(day);
              const first = d.getUTCDate() === 1 || day === rangeStart;
              return (
                <div key={day} className="shrink-0 text-[10.5px] font-semibold text-ink-3" style={{ width: DAY_W }}>
                  {first ? `${MONTHS[d.getUTCMonth()]}` : " "}
                </div>
              );
            })}
          </div>
          <div className="flex border-b border-border pb-1">
            <div className="sticky left-0 z-10 shrink-0 bg-bg" style={{ width: LABEL_W }} />
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

          <div className="flex">
            {/* Row titles */}
            <div className="sticky left-0 z-10 shrink-0 bg-bg pt-1.5" style={{ width: LABEL_W }}>
              {visible.map(({ row }) => (
                <button
                  key={row._id}
                  onClick={() => openRow(row._id)}
                  className="flex w-full items-center truncate rounded-md pr-3 text-left text-[12.5px] text-ink hover:bg-hov"
                  style={{ height: ROW_H }}
                  title={row.title || "Untitled"}
                >
                  <span className="truncate px-1">{row.title || "Untitled"}</span>
                </button>
              ))}
            </div>

            {/* Bars */}
            <div className="relative" style={{ width: trackW, height: bodyH }}>
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
              {visible.map(({ row, startDay, endDay }, i) => {
                const isDragging = drag?.rowId === row._id;
                const dShift = isDragging && drag!.mode === "move" ? drag!.deltaDays : 0;
                const dResize = isDragging && drag!.mode === "resize" ? drag!.deltaDays : 0;
                const s = startDay + dShift * DAY_MS;
                const e = Math.max(s, endDay + (dShift + dResize) * DAY_MS);
                // Clip to the window, so a range that starts or ends outside it still shows.
                const shownStart = Math.max(s, rangeStart);
                const shownEnd = Math.min(e, rangeEnd);
                const left = ((shownStart - rangeStart) / DAY_MS) * DAY_W;
                const width = Math.max(((shownEnd - shownStart) / DAY_MS + 1) * DAY_W - 6, DAY_W - 6);
                const title = row.title || "Untitled";
                const fits = width >= title.length * TITLE_CHAR_W + BAR_PADDING_W;
                return (
                  <div
                    key={row._id}
                    className="absolute flex items-center"
                    style={{ left, top: i * ROW_H + 6, height: ROW_H - 10 }}
                  >
                    <div
                      className={cn(
                        "evt group relative flex h-full cursor-grab items-center rounded-md px-2 text-[12px] font-medium",
                        colorVarClass(db.color),
                        isDragging && "cursor-grabbing opacity-80"
                      )}
                      style={{ width }}
                      onPointerDown={(ev) => startDrag(ev, row._id, "move", { startDay, endDay })}
                      onClick={() => !drag && openRow(row._id)}
                    >
                      {fits && <span className="truncate">{title}</span>}
                      <span
                        className="absolute -right-0.5 top-0 h-full w-2.5 cursor-ew-resize rounded-r-md opacity-0 group-hover:opacity-100 group-hover:bg-white/30"
                        onPointerDown={(ev) => startDrag(ev, row._id, "resize", { startDay, endDay })}
                      />
                    </div>
                    {!fits && (
                      <span className="pointer-events-none whitespace-nowrap pl-1.5 text-[12px] text-ink-2">
                        {title}
                      </span>
                    )}
                  </div>
                );
              })}
              {visible.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-3">
                  Nothing scheduled in this range
                </div>
              )}
              {arrows.length > 0 && (
                <svg className="pointer-events-none absolute inset-0" width={trackW} height={bodyH}>
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
