import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Zap } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useUI } from "../../state/ui";
import { cn } from "../../lib/utils";
import { colorVarClass } from "../../lib/optionColors";
import { calendarToEpochMs, epochToCalendarMs, fmtTime, todayCalendarMs } from "../../lib/dates";

const DAY_MS = 86_400_000;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// WHAT: Month overview — events + auto-scheduled block indicators per day.
// Click a day to zoom into its week.
export function MonthGrid({ anchor }: { anchor: number }) {
  const setCalMode = useUI((s) => s.setCalMode);
  const setCalAnchor = useUI((s) => s.setCalAnchor);
  const openRow = useUI((s) => s.openRow);

  const { gridStart, cells, monthIdx } = useMemo(() => {
    const a = new Date(anchor);
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const gridStartDate = new Date(first);
    gridStartDate.setDate(1 - first.getDay());
    const gridStart = gridStartDate.getTime();
    const cells = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStartDate);
      d.setDate(gridStartDate.getDate() + i);
      return d.getTime();
    });
    return { gridStart, cells, monthIdx: a.getMonth() };
  }, [anchor]);

  const rangeEnd = gridStart + 43 * DAY_MS;
  const events = useQuery(api.events.listRange, { start: gridStart, end: rangeEnd }) ?? [];
  const blocks = useQuery(api.timeBlocks.listRange, { start: gridStart, end: rangeEnd }) ?? [];
  const dueItems = useQuery(api.calendarData.listForCalendar) ?? [];
  const today = todayCalendarMs();

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
      <div className="grid grid-cols-7 border-b border-border">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="px-2 py-1 text-[11px] font-semibold text-ink-3">{d}</div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 border-l border-border">
        {cells.map((dayStart) => {
          const dayCal = epochToCalendarMs(dayStart + DAY_MS / 2);
          const dayEvents = events.filter((e) => e.start < dayStart + DAY_MS && e.end > dayStart);
          const dayBlocks = blocks.filter((b) => b.start < dayStart + DAY_MS && b.end > dayStart);
          const dayDue = dueItems.filter((it) => {
            const s = it.date.includeTime ? epochToCalendarMs(it.date.start) : it.date.start;
            const e = it.date.end !== undefined ? (it.date.includeTime ? epochToCalendarMs(it.date.end) : it.date.end) : s;
            return dayCal >= s && dayCal <= e;
          });
          const inMonth = new Date(dayStart).getMonth() === monthIdx;
          const isToday = dayCal === today;
          const shown = dayEvents.slice(0, 2);
          const extra = dayEvents.length - shown.length + dayDue.length;

          return (
            <button
              key={dayStart}
              onClick={() => {
                setCalAnchor(calendarToEpochMs(dayCal, 12 * 60));
                setCalMode("week");
              }}
              className={cn(
                "flex flex-col gap-0.5 border-b border-r border-border p-1 text-left hover:bg-hov",
                !inMonth && "bg-[color-mix(in_srgb,var(--hover)_40%,transparent)]"
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
                    isToday ? "bg-accent font-bold text-white" : inMonth ? "text-ink-2" : "text-ink-3"
                  )}
                >
                  {new Date(dayStart).getDate()}
                </span>
                {dayBlocks.length > 0 && (
                  <span className="flex items-center gap-0.5 text-[10px] text-accent" title={`${dayBlocks.length} scheduled blocks`}>
                    <Zap size={10} />
                    {dayBlocks.length}
                  </span>
                )}
              </div>
              {shown.map((e) => (
                <span
                  key={e._id}
                  className={cn("evt truncate rounded px-1 text-[10.5px] font-medium", colorVarClass(e.color))}
                  title={`${e.title} ${e.allDay ? "" : fmtTime(e.start)}`}
                >
                  {e.title || "Untitled"}
                </span>
              ))}
              {dayDue.slice(0, 1).map((it) => (
                <span
                  key={it.rowId}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    openRow(it.rowId);
                  }}
                  className={cn(
                    "truncate rounded border border-border px-1 text-[10.5px] text-ink-2",
                    it.done && "line-through opacity-60"
                  )}
                >
                  ⚑ {it.title}
                </span>
              ))}
              {extra > 0 && <span className="px-1 text-[10px] text-ink-3">+{extra} more</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function monthTitle(anchor: number): string {
  const d = new Date(anchor);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}
