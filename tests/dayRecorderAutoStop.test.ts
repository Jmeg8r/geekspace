import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAutoStop, stopDue } from "../electron/dayRecorderAutoStop.mjs";

// WHAT: the Day Recorder's auto-stop (plan PR 7). WHY tested: it is the only code that turns
// capture off on a schedule, and the rules James set are easy to get subtly wrong: only time
// spent on counts, midnight ends a late start, sleep across a stop moment stops at wake, and
// nothing here ever turns capture on.

// WHY a fixed zone with DST: the rule works in local time, and one test is a DST-change day.
const ZONE = "America/New_York";
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = ZONE;
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const SIX_PM = 18 * 60;
const MINUTE = 60_000;

describe("stopDue", () => {
  it("is due when the end time falls inside the span", () => {
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 17, 59), now: at(2026, 11, 9, 18, 0) })).toEqual({
      at: at(2026, 11, 9, 18, 0),
      reason: "endTime",
    });
  });

  it("is not due before the end time, nor when the span starts exactly on it", () => {
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 17, 0), now: at(2026, 11, 9, 17, 59) })).toBeNull();
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 18, 0), now: at(2026, 11, 9, 18, 1) })).toBeNull();
  });

  it("is due at wake when sleep crossed the end time", () => {
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 16, 0), now: at(2026, 11, 9, 21, 30) })?.reason).toBe("endTime");
  });

  it("lets a start after the end time run, and stops it at midnight", () => {
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 19, 0), now: at(2026, 11, 9, 23, 59) })).toBeNull();
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 23, 59), now: at(2026, 11, 10, 0, 0) })).toEqual({
      at: at(2026, 11, 10, 0, 0),
      reason: "midnight",
    });
  });

  it("stops at an end time of midnight itself", () => {
    expect(stopDue({ stopAtMin: 0, since: at(2026, 11, 9, 23, 30), now: at(2026, 11, 10, 0, 1) })?.at).toBe(at(2026, 11, 10, 0, 0));
  });

  it("finds a stop moment across several days of sleep", () => {
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 6, 19, 0), now: at(2026, 11, 9, 9, 0) })).not.toBeNull();
  });

  it("uses local wall-clock time on a DST-change day", () => {
    // 2026-11-01 is the US fall-back day: 18:00 local is 23:00 UTC, not 22:00.
    const due = stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 1, 17, 30), now: at(2026, 11, 1, 18, 30) });
    expect(due?.at).toBe(Date.UTC(2026, 10, 1, 23, 0));
  });

  it("is never due without an end time", () => {
    expect(stopDue({ stopAtMin: null, since: at(2026, 11, 9, 8, 0), now: at(2026, 11, 10, 8, 0) })).toBeNull();
  });

  it("is never due for an empty or backwards span", () => {
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 18, 0), now: at(2026, 11, 9, 18, 0) })).toBeNull();
    expect(stopDue({ stopAtMin: SIX_PM, since: at(2026, 11, 9, 19, 0), now: at(2026, 11, 9, 17, 0) })).toBeNull();
  });
});

describe("createAutoStop", () => {
  function harness(start: number) {
    let clock = start;
    const stops: { at: number; reason: string }[] = [];
    const autoStop = createAutoStop({ now: () => clock, stop: async (due) => void stops.push(due) });
    return {
      autoStop,
      stops,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("stops a running recorder when the end time comes, once", async () => {
    const h = harness(at(2026, 11, 9, 17, 58));
    h.autoStop.update({ enabled: true, stopAtMin: SIX_PM });
    h.advance(MINUTE);
    await h.autoStop.check();
    expect(h.stops).toEqual([]);
    h.advance(MINUTE);
    await h.autoStop.check();
    h.advance(MINUTE);
    await h.autoStop.check();
    expect(h.stops).toEqual([{ at: at(2026, 11, 9, 18, 0), reason: "endTime" }]);
  });

  it("counts only time spent on: turning it on after the end time starts afresh", async () => {
    const h = harness(at(2026, 11, 9, 9, 0));
    h.autoStop.update({ enabled: false, stopAtMin: SIX_PM });
    h.advance(10 * 60 * MINUTE);
    await h.autoStop.check();
    h.autoStop.update({ enabled: true, stopAtMin: SIX_PM });
    h.advance(MINUTE);
    await h.autoStop.check();
    expect(h.stops).toEqual([]);
  });

  it("stops at wake when sleep crossed the end time", async () => {
    const h = harness(at(2026, 11, 9, 17, 0));
    h.autoStop.update({ enabled: true, stopAtMin: SIX_PM });
    h.advance(4 * 60 * MINUTE);
    await h.autoStop.check();
    expect(h.stops.map((s) => s.reason)).toEqual(["endTime"]);
  });

  it("does nothing while off or without an end time", async () => {
    const h = harness(at(2026, 11, 9, 17, 0));
    h.autoStop.update({ enabled: true, stopAtMin: null });
    h.advance(8 * 60 * MINUTE);
    await h.autoStop.check();
    h.autoStop.update({ enabled: false, stopAtMin: SIX_PM });
    h.advance(24 * 60 * MINUTE);
    await h.autoStop.check();
    expect(h.stops).toEqual([]);
  });

  it("only ever stops: its one action is the stop it was given", async () => {
    const stop = vi.fn(async () => undefined);
    let clock = at(2026, 11, 9, 17, 59);
    const autoStop = createAutoStop({ now: () => clock, stop });
    autoStop.update({ enabled: true, stopAtMin: SIX_PM });
    clock += MINUTE;
    await autoStop.check();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(Object.keys(autoStop).sort()).toEqual(["check", "update"]);
  });

  it("tries again next check when the stop fails", async () => {
    let clock = at(2026, 11, 9, 17, 59);
    let fails = 1;
    const stops: number[] = [];
    const autoStop = createAutoStop({
      now: () => clock,
      stop: async (due) => {
        if (fails-- > 0) throw new Error("SYNTHETIC: Convex unreachable");
        stops.push(due.at);
      },
    });
    autoStop.update({ enabled: true, stopAtMin: SIX_PM });
    clock += MINUTE;
    await expect(autoStop.check()).rejects.toThrow(/unreachable/);
    clock += MINUTE;
    await autoStop.check();
    expect(stops).toEqual([at(2026, 11, 9, 18, 0)]);
  });
});
