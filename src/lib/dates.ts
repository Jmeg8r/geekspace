import { addDays, format } from "date-fns";
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

// --- Local-day arithmetic for the week grid ---------------------------------------------
// WHY: a day is not always 24 hours. Stepping by a fixed 86,400,000 ms put every column
// after a DST change an hour off (the next US change is 2026-11-01, a 25-hour day). These
// work in local calendar terms instead. See docs/changes/2026-10-15-scheduler-dst-perf/.

/** The local midnights of the seven days starting at `weekStartMs` (itself a midnight). */
export function weekDays(weekStartMs: number): number[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStartMs, i).getTime());
}

/** The local midnight after `dayMs`: 23, 24 or 25 hours later. */
export function nextDay(dayMs: number): number {
  return addDays(dayMs, 1).getTime();
}

/** Wall-clock `minute` (from midnight) on the local date of `dayMs`. */
export function atMinuteOfDay(dayMs: number, minute: number): number {
  const d = new Date(dayMs);
  d.setHours(0, minute, 0, 0);
  return d.getTime();
}

/**
 * Where `ms` falls on the local day starting at `dayMs`, in wall-clock minutes (0–1440):
 * 0 if before the day, 1440 if after it. 9:00 is 540 even on a 23- or 25-hour day.
 */
export function wallMinuteOn(dayMs: number, ms: number): number {
  if (ms <= dayMs) return 0;
  if (ms >= nextDay(dayMs)) return 24 * 60;
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Where an item spanning `start`–`end` sits on the local day starting at `dayMs`, as
 * wall-clock minutes [startMin, endMin]. On a fall-back day an item inside the repeated hour
 * can end at an earlier wall time than it starts (01:45 EDT → 01:15 EST is 30 minutes); it
 * is then drawn with its real duration from its start instead of vanishing.
 */
export function wallSpanOn(dayMs: number, start: number, end: number): [number, number] {
  const startMin = wallMinuteOn(dayMs, start);
  let endMin = wallMinuteOn(dayMs, end);
  if (endMin <= startMin && end > start) {
    const visibleFrom = Math.max(start, dayMs);
    endMin = Math.min(24 * 60, startMin + (end - visibleFrom) / 60_000);
  }
  return [startMin, endMin];
}
