import { describe, expect, it } from "vitest";
import { atMinuteOfDay, nextDay, weekDays } from "../src/lib/dates";

// WHAT: week-grid date arithmetic across a DST change. The next US change is Sunday
// 2026-11-01 (clocks go back at 02:00, so that day has 25 hours).
// See docs/changes/2026-10-15-scheduler-dst-perf/.
//
// Node re-reads TZ when process.env.TZ is assigned; the control test below fails if it
// did not take effect, so a wrong zone cannot make the rest pass vacuously.
process.env.TZ = "America/New_York";

const HOUR_MS = 3_600_000;
const sundayNov1 = new Date(2026, 10, 1).getTime(); // local midnight

describe("DST week arithmetic (America/New_York)", () => {
  it("control: the UTC offset really changes across Nov 1", () => {
    expect(new Date(2026, 9, 31, 12).getTimezoneOffset()).not.toBe(new Date(2026, 10, 2, 12).getTimezoneOffset());
  });

  it("weekDays gives each day's local midnight, not 24-hour steps", () => {
    const days = weekDays(sundayNov1).map((ms) => new Date(ms));
    expect(days.map((d) => d.getDate())).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const d of days) expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });

  it("atMinuteOfDay is wall-clock time on that date", () => {
    const [sun, mon] = weekDays(sundayNov1);
    expect(new Date(atMinuteOfDay(sun, 9 * 60)).getHours()).toBe(9);
    expect(new Date(atMinuteOfDay(mon, 9 * 60)).getHours()).toBe(9);
    expect(new Date(atMinuteOfDay(mon, 17 * 60 + 30)).getMinutes()).toBe(30);
  });

  it("nextDay spans the 25-hour fall-back day", () => {
    expect(nextDay(sundayNov1) - sundayNov1).toBe(25 * HOUR_MS);
    expect(new Date(nextDay(sundayNov1)).getDate()).toBe(2);
  });
});
