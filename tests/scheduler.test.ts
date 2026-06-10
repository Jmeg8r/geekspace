import { describe, it, expect } from "vitest";
import {
  buildDayWindows,
  calendarDateToLocalMs,
  computeSchedule,
  localMsToCalendarDate,
  type SchedulerConfig,
  type SchedulerTask,
} from "../convex/lib/scheduler";

// All tests use tzOffsetMin: 0 so wall-clock assertions read directly in UTC.
// 2026-06-08 is a Monday.
const cfg: SchedulerConfig = {
  workDays: [1, 2, 3, 4, 5],
  dayStartMin: 9 * 60,
  dayEndMin: 17 * 60,
  minChunkMin: 30,
  maxChunkMin: 120,
  bufferMin: 10,
  horizonDays: 7,
  granularityMin: 15,
  tzOffsetMin: 0,
};

const at = (dayFromMon: number, h: number, m = 0) =>
  Date.UTC(2026, 5, 8 + dayFromMon, h, m);
const MON_8AM = at(0, 8);

const task = (overrides: Partial<SchedulerTask> & { id: string }): SchedulerTask => ({
  title: overrides.id,
  remainingMin: 60,
  priority: 2,
  ...overrides,
});

describe("computeSchedule", () => {
  it("places a task at the start of working hours", () => {
    const { blocks, warnings } = computeSchedule(MON_8AM, [task({ id: "a" })], [], cfg);
    expect(warnings).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBe(at(0, 9));
    expect(blocks[0].end).toBe(at(0, 10));
    expect(blocks[0].pastDue).toBe(false);
  });

  it("schedules around fixed events with buffer", () => {
    const busy = [{ start: at(0, 9), end: at(0, 10) }];
    const { blocks } = computeSchedule(MON_8AM, [task({ id: "a" })], busy, cfg);
    // 10:00 + 10min buffer → 10:10 → snapped to 10:15
    expect(blocks[0].start).toBe(at(0, 10, 15));
  });

  it("orders by earliest due date first (EDF)", () => {
    const tasks = [
      task({ id: "a", dueMs: at(2, 17) }),
      task({ id: "b", dueMs: at(1, 17) }),
    ];
    const { blocks } = computeSchedule(MON_8AM, tasks, [], cfg);
    const first = blocks.reduce((m, b) => (b.start < m.start ? b : m));
    expect(first.taskId).toBe("b");
  });

  it("breaks due-date ties by priority", () => {
    const due = at(2, 17);
    const tasks = [
      task({ id: "low", dueMs: due, priority: 3 }),
      task({ id: "urgent", dueMs: due, priority: 0 }),
    ];
    const { blocks } = computeSchedule(MON_8AM, tasks, [], cfg);
    const first = blocks.reduce((m, b) => (b.start < m.start ? b : m));
    expect(first.taskId).toBe("urgent");
  });

  it("splits long tasks into max-chunk blocks with buffers between", () => {
    const { blocks, warnings } = computeSchedule(
      MON_8AM,
      [task({ id: "big", remainingMin: 300 })],
      [],
      cfg
    );
    expect(warnings).toEqual([]);
    const durations = blocks.map((b) => (b.end - b.start) / 60000);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(300);
    expect(Math.max(...durations)).toBeLessThanOrEqual(cfg.maxChunkMin);
    // chunks don't overlap and respect buffer ordering
    const sorted = [...blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
  });

  it("never creates a block smaller than the min chunk", () => {
    // 20-minute gap between two events — too small for a 30-min min chunk.
    const busy = [
      { start: at(0, 9), end: at(0, 12) },
      { start: at(0, 12, 20), end: at(0, 16, 30) },
    ];
    const { blocks } = computeSchedule(MON_8AM, [task({ id: "a", remainingMin: 30 })], busy, cfg);
    for (const b of blocks) {
      expect((b.end - b.start) / 60000).toBeGreaterThanOrEqual(30);
      // must not be inside the 20-minute gap
      expect(b.start >= at(0, 16, 45) || b.end <= at(0, 9)).toBe(true);
    }
  });

  it("honors noSplit by finding one contiguous slot", () => {
    const busy = [{ start: at(0, 12), end: at(0, 13) }];
    const { blocks } = computeSchedule(
      MON_8AM,
      [task({ id: "deep", remainingMin: 180, noSplit: true })],
      busy,
      cfg
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0].end - blocks[0].start) / 60000).toBe(180);
    // morning has only 170 usable minutes (9:00–11:50), so it lands after lunch
    expect(blocks[0].start).toBe(at(0, 13, 15));
  });

  it("flags past-due blocks and emits a past_due warning", () => {
    const { blocks, warnings } = computeSchedule(
      MON_8AM,
      [task({ id: "late", dueMs: at(-1, 17) })],
      [],
      cfg
    );
    expect(blocks.every((b) => b.pastDue)).toBe(true);
    expect(warnings).toEqual([
      { taskId: "late", title: "late", unscheduledMin: 0, reason: "past_due" },
    ]);
  });

  it("warns with remaining minutes when capacity runs out", () => {
    const tiny: SchedulerConfig = { ...cfg, horizonDays: 1, dayEndMin: 10 * 60 };
    const { blocks, warnings } = computeSchedule(
      MON_8AM,
      [task({ id: "big", remainingMin: 300 })],
      [],
      tiny
    );
    const placed = blocks.reduce((a, b) => a + (b.end - b.start) / 60000, 0);
    expect(placed).toBe(60);
    expect(warnings).toEqual([
      { taskId: "big", title: "big", unscheduledMin: 240, reason: "no_capacity" },
    ]);
  });

  it("skips non-working days", () => {
    const satMorning = Date.UTC(2026, 5, 6, 10); // Saturday
    const { blocks } = computeSchedule(satMorning, [task({ id: "a" })], [], cfg);
    expect(blocks[0].start).toBe(at(0, 9)); // Monday 9:00
  });

  it("respects earliestMs", () => {
    const { blocks } = computeSchedule(
      MON_8AM,
      [task({ id: "a", earliestMs: at(0, 14) })],
      [],
      cfg
    );
    expect(blocks[0].start).toBe(at(0, 14));
  });

  it("treats locked blocks as busy time", () => {
    const busy = [{ start: at(0, 9), end: at(0, 12) }];
    const { blocks } = computeSchedule(MON_8AM, [task({ id: "a" })], busy, cfg);
    expect(blocks[0].start).toBe(at(0, 12, 15));
  });

  it("is deterministic", () => {
    const tasks = [
      task({ id: "a", remainingMin: 90, dueMs: at(3, 17), priority: 1 }),
      task({ id: "b", remainingMin: 240, dueMs: at(2, 17), priority: 0 }),
      task({ id: "c", remainingMin: 45 }),
    ];
    const busy = [{ start: at(0, 10), end: at(0, 11, 30) }];
    const r1 = computeSchedule(MON_8AM, tasks, busy, cfg);
    const r2 = computeSchedule(MON_8AM, tasks, busy, cfg);
    expect(r1).toEqual(r2);
  });

  it("schedules higher-priority work before lower at scale", () => {
    const tasks = [
      task({ id: "p3", priority: 3, remainingMin: 120 }),
      task({ id: "p0", priority: 0, remainingMin: 120 }),
      task({ id: "p1", priority: 1, remainingMin: 120 }),
    ];
    const { blocks } = computeSchedule(MON_8AM, tasks, [], cfg);
    const firstStart = (id: string) =>
      Math.min(...blocks.filter((b) => b.taskId === id).map((b) => b.start));
    expect(firstStart("p0")).toBeLessThan(firstStart("p1"));
    expect(firstStart("p1")).toBeLessThan(firstStart("p3"));
  });
});

describe("calendar date helpers", () => {
  it("round-trips calendar dates through a timezone offset", () => {
    const day = Date.UTC(2026, 5, 10); // calendar date June 10
    const ms = calendarDateToLocalMs(day, 240, 17 * 60); // 5pm EDT
    expect(localMsToCalendarDate(ms, 240)).toBe(day);
  });

  it("builds windows only on working days within the horizon", () => {
    const windows = buildDayWindows(MON_8AM, cfg);
    expect(windows).toHaveLength(5); // Mon-Fri
    expect(windows[0].start).toBe(at(0, 9));
    expect(windows[0].end).toBe(at(0, 17));
  });
});
