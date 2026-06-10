import { format } from "date-fns";
import type { DateValue } from "../../convex/lib/types";

// WHAT: Date display + calendar-date conversion helpers.
// Calendar-date convention (see DateValue): date-only values are UTC midnight of
// the calendar date, so display/extraction must use UTC accessors — local
// formatting would shift the day near midnight.

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function fmtCalendarDate(utcMidnightMs: number): string {
  const d = new Date(utcMidnightMs);
  const year = d.getUTCFullYear();
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return year === new Date().getFullYear() ? base : `${base}, ${year}`;
}

export function fmtDateValue(dv: DateValue): string {
  if (dv.includeTime) {
    const start = format(dv.start, "MMM d, h:mm a");
    return dv.end ? `${start} → ${format(dv.end, "h:mm a")}` : start;
  }
  const start = fmtCalendarDate(dv.start);
  return dv.end && dv.end !== dv.start ? `${start} → ${fmtCalendarDate(dv.end)}` : start;
}

/** Calendar date (UTC midnight) of the user's *local* today. */
export function todayCalendarMs(): number {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

/** Calendar date (UTC midnight) for a local epoch timestamp. */
export function epochToCalendarMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Local epoch ms for a calendar date at a given minute of day. */
export function calendarToEpochMs(utcMidnightMs: number, minOfDay = 0): number {
  const d = new Date(utcMidnightMs);
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    Math.floor(minOfDay / 60),
    minOfDay % 60
  ).getTime();
}

export const fmtTime = (ms: number) => format(ms, "h:mm a").toLowerCase();

export function fmtDuration(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function minOfDayLabel(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h < 12 ? "am" : "pm";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh} ${ampm}` : `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}
