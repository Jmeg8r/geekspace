import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DateValue } from "../../../convex/lib/types";
import { epochToCalendarMs, calendarToEpochMs, todayCalendarMs } from "../../lib/dates";
import { cn } from "../../lib/utils";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// WHAT: Notion-style date picker — calendar dates by default, optional time and
// end date. Emits values following the DateValue convention.
export function DatePicker({
  value,
  onChange,
  close,
}: {
  value?: DateValue;
  onChange: (v: DateValue | undefined) => void;
  close?: () => void;
}) {
  const startCal = value
    ? value.includeTime
      ? epochToCalendarMs(value.start)
      : value.start
    : undefined;
  const endCal =
    value?.end !== undefined
      ? value.includeTime
        ? epochToCalendarMs(value.end)
        : value.end
      : undefined;

  const [viewMonth, setViewMonth] = useState(() => {
    const base = startCal ?? todayCalendarMs();
    const d = new Date(base);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  });
  const [rangeMode, setRangeMode] = useState(endCal !== undefined);
  const [pickingEnd, setPickingEnd] = useState(false);

  const includeTime = value?.includeTime === true;
  const startMin = includeTime && value ? minutesOfDay(value.start) : 9 * 60;
  const endMin = includeTime && value?.end !== undefined ? minutesOfDay(value.end) : 10 * 60;

  function minutesOfDay(epoch: number): number {
    const d = new Date(epoch);
    return d.getHours() * 60 + d.getMinutes();
  }

  function emit(nextStartCal?: number, nextEndCal?: number, nextIncludeTime?: boolean, nextStartMin?: number, nextEndMin?: number) {
    const sc = nextStartCal ?? startCal;
    if (sc === undefined) {
      onChange(undefined);
      return;
    }
    const it = nextIncludeTime ?? includeTime;
    const ec = nextEndCal !== undefined ? nextEndCal : rangeMode ? endCal : undefined;
    if (it) {
      const sm = nextStartMin ?? startMin;
      const em = nextEndMin ?? endMin;
      onChange({
        start: calendarToEpochMs(sc, sm),
        end: ec !== undefined ? calendarToEpochMs(ec, em) : undefined,
        includeTime: true,
      });
    } else {
      onChange({ start: sc, end: ec, includeTime: undefined });
    }
  }

  const monthDate = new Date(viewMonth);
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const today = todayCalendarMs();

  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => Date.UTC(year, month, i + 1)),
  ];

  function clickDay(dayMs: number) {
    if (rangeMode && pickingEnd && startCal !== undefined && dayMs >= startCal) {
      emit(undefined, dayMs);
      setPickingEnd(false);
    } else {
      emit(dayMs, rangeMode ? undefined : undefined);
      if (rangeMode) setPickingEnd(true);
    }
  }

  return (
    <div className="w-64 p-2.5">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[13px] font-semibold">
          {MONTH_NAMES[month]} {year}
        </span>
        <span className="flex gap-0.5">
          <button onClick={() => setViewMonth(Date.UTC(year, month - 1, 1))} className="rounded p-1 text-ink-2 hover:bg-hov">
            <ChevronLeft size={14} />
          </button>
          <button onClick={() => setViewMonth(Date.UTC(year, month + 1, 1))} className="rounded p-1 text-ink-2 hover:bg-hov">
            <ChevronRight size={14} />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center">
        {WEEKDAYS.map((d, i) => (
          <span key={i} className="py-1 text-[10px] font-medium text-ink-3">
            {d}
          </span>
        ))}
        {cells.map((day, i) =>
          day === null ? (
            <span key={`x${i}`} />
          ) : (
            <button
              key={day}
              onClick={() => clickDay(day)}
              className={cn(
                "mx-auto flex h-7 w-7 items-center justify-center rounded-md text-[12px] hover:bg-hov",
                day === today && "font-bold text-accent",
                (day === startCal || day === endCal) && "bg-accent text-white hover:bg-accent",
                startCal !== undefined &&
                  endCal !== undefined &&
                  day > startCal &&
                  day < endCal &&
                  "bg-accent-soft"
              )}
            >
              {new Date(day).getUTCDate()}
            </button>
          )
        )}
      </div>

      <div className="mt-2 space-y-1.5 border-t border-border pt-2">
        <label className="flex items-center justify-between text-[12px] text-ink-2">
          <span>Include time</span>
          <input
            type="checkbox"
            checked={includeTime}
            onChange={(e) => emit(undefined, undefined, e.target.checked)}
            className="accent-[var(--accent)]"
          />
        </label>
        {includeTime && (
          <div className="flex items-center gap-1.5">
            <TimeSelect value={startMin} onChange={(m) => emit(undefined, undefined, true, m)} />
            {rangeMode && endCal !== undefined && (
              <>
                <span className="text-[11px] text-ink-3">→</span>
                <TimeSelect value={endMin} onChange={(m) => emit(undefined, undefined, true, undefined, m)} />
              </>
            )}
          </div>
        )}
        <label className="flex items-center justify-between text-[12px] text-ink-2">
          <span>End date</span>
          <input
            type="checkbox"
            checked={rangeMode}
            onChange={(e) => {
              setRangeMode(e.target.checked);
              if (!e.target.checked) {
                emit(undefined, undefined);
                setPickingEnd(false);
              } else {
                setPickingEnd(true);
              }
            }}
            className="accent-[var(--accent)]"
          />
        </label>
        <div className="flex justify-between pt-0.5">
          <button
            onClick={() => {
              onChange(undefined);
              close?.();
            }}
            className="rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-hov"
          >
            Clear
          </button>
          {close && (
            <button onClick={close} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:bg-accent-2">
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TimeSelect({ value, onChange }: { value: number; onChange: (min: number) => void }) {
  const options: number[] = [];
  for (let m = 0; m < 24 * 60; m += 15) options.push(m);
  return (
    <select
      value={value - (value % 15)}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[12px] outline-none"
    >
      {options.map((m) => {
        const h = Math.floor(m / 60);
        const mm = String(m % 60).padStart(2, "0");
        const ampm = h < 12 ? "AM" : "PM";
        const hh = h % 12 === 0 ? 12 : h % 12;
        return (
          <option key={m} value={m}>
            {hh}:{mm} {ampm}
          </option>
        );
      })}
    </select>
  );
}
