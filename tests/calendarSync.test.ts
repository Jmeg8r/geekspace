import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// WHAT: the macOS Calendar mirror deletes only what a sync actually read, and never
// duplicates or drops long events. See docs/changes/2026-10-16-electron-sync/.

const modules = import.meta.glob("../convex/**/*.ts");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 12);
const windowStart = NOW - 7 * DAY;
const windowEnd = NOW + 35 * DAY;

type Item = { externalId: string; title: string; start: number; end: number; calendarName: string };
const ev = (id: string, cal: string, start: number, hours = 1): Item => ({
  externalId: id,
  title: id,
  start,
  end: start + hours * 3_600_000,
  calendarName: cal,
});

async function sync(t: ReturnType<typeof convexTest>, items: Item[], completeCalendars: string[]) {
  return t.mutation(api.events.syncExternal, { windowStart, windowEnd, items, completeCalendars });
}
const mirrors = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => (await ctx.db.query("events").collect()).filter((e) => e.source === "macos"));

describe("events.syncExternal", () => {
  it("keeps a calendar's events when that calendar could not be read", async () => {
    const t = convexTest(schema, modules);
    await sync(t, [ev("w1", "Work", NOW), ev("h1", "Home", NOW + DAY)], ["Work", "Home"]);
    // Next pass: Home failed to read, so it is absent from both items and completeCalendars.
    const result = await sync(t, [ev("w1", "Work", NOW)], ["Work"]);
    expect(result.removed).toBe(0);
    expect((await mirrors(t)).map((e) => e.externalId).sort()).toEqual(["h1", "w1"]);
  });

  it("still removes events that vanished from a calendar it read completely", async () => {
    const t = convexTest(schema, modules);
    await sync(t, [ev("w1", "Work", NOW), ev("w2", "Work", NOW + DAY)], ["Work"]);
    const result = await sync(t, [ev("w1", "Work", NOW)], ["Work"]);
    expect(result.removed).toBe(1);
    expect((await mirrors(t)).map((e) => e.externalId)).toEqual(["w1"]);
  });

  it("keeps a long event that started before the window (the fetch can't see it)", async () => {
    const t = convexTest(schema, modules);
    const longEvent = ev("trip", "Work", windowStart - 3 * DAY, 24 * 10);
    await t.run((ctx) => ctx.db.insert("events", { ...longEvent, source: "macos" }));
    const result = await sync(t, [ev("w1", "Work", NOW)], ["Work"]);
    expect(result.removed).toBe(0);
    expect((await mirrors(t)).some((e) => e.externalId === "trip")).toBe(true);
  });

  it("never duplicates an event that started more than 35 days before the window", async () => {
    const t = convexTest(schema, modules);
    const veryLong = ev("sabbatical", "Work", windowStart - 60 * DAY, 24 * 90);
    await t.run((ctx) => ctx.db.insert("events", { ...veryLong, source: "macos" }));
    const result = await sync(t, [veryLong], ["Work"]);
    expect(result.created).toBe(0);
    expect((await mirrors(t)).filter((e) => e.externalId === "sabbatical")).toHaveLength(1);
  });
});
