import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  computeSchedule,
  MIN_MS,
  type SchedulerConfig,
  type SchedulerTask,
  type SchedulerWarning,
} from "../convex/lib/scheduler";
import { isNumber } from "../convex/lib/predicates";
import type { PropertyDef } from "../convex/lib/types";

// WHAT: the auto-scheduler books each task once, around everything it should.
// See docs/changes/2026-10-15-scheduler-correctness/.

const DAY_MS = 86_400_000;

// --- Engine (pure) -------------------------------------------------------------------

// tzOffsetMin 0 so assertions read in UTC. 2026-06-08 is a Monday.
const cfg: SchedulerConfig = {
  workDays: [1, 2, 3, 4, 5],
  dayStartMin: 9 * 60,
  dayEndMin: 17 * 60,
  minChunkMin: 30,
  maxChunkMin: 120,
  bufferMin: 10,
  horizonDays: 2,
  granularityMin: 15,
  tzOffsetMin: 0,
};
const MON_8AM = Date.UTC(2026, 5, 8, 8);
const task = (o: Partial<SchedulerTask> & { id: string }): SchedulerTask => ({
  title: o.id,
  remainingMin: 60,
  priority: 2,
  ...o,
});

describe("computeSchedule", () => {
  it("does not start a dependent while its blocker still has unplaced work", () => {
    // The blocker cannot be split and is longer than a working day, so none of it can be
    // placed, while the horizon still has room the dependent must not take.
    const tasks = [
      task({ id: "blocker", remainingMin: 10 * 60, noSplit: true }),
      task({ id: "dependent", blockedBy: ["blocker"] }),
    ];
    const { blocks } = computeSchedule(MON_8AM, tasks, [], cfg);
    expect(blocks.filter((b) => b.taskId === "blocker")).toEqual([]);
    expect(blocks.filter((b) => b.taskId === "dependent")).toEqual([]);
  });

  it("gives each task at most one warning, naming a cycle as a cycle", () => {
    // a and b block each other, and neither fits: the cycle is the reason worth showing.
    const tasks = [
      task({ id: "a", blockedBy: ["b"], remainingMin: 60 * 40 }),
      task({ id: "b", blockedBy: ["a"], remainingMin: 60 * 40 }),
    ];
    const { warnings } = computeSchedule(MON_8AM, tasks, [], cfg);
    const perTask = new Map<string, string[]>();
    for (const w of warnings) perTask.set(w.taskId, [...(perTask.get(w.taskId) ?? []), w.reason]);
    for (const reasons of perTask.values()) expect(reasons).toHaveLength(1);
    expect([...perTask.values()].flat()).toContain("dependency_cycle");
  });

  // Codex review of PR #54, round 3: a task whose estimate is fully reserved (locked or
  // started blocks) still belongs to the dependency graph.
  it("keeps a fully reserved task in cycle detection", () => {
    const tasks = [
      task({ id: "a", blockedBy: ["b"], remainingMin: 0, reservedUntilMs: MON_8AM + 3 * 3_600_000 }),
      task({ id: "b", blockedBy: ["a"] }),
    ];
    const { warnings, blocks } = computeSchedule(MON_8AM, tasks, [], cfg);
    expect(warnings.map((w) => w.reason)).toContain("dependency_cycle");
    expect(blocks.filter((b) => b.taskId === "a")).toEqual([]);
  });

  it("starts a dependent only after a fully reserved blocker's reserved work ends", () => {
    const reservedUntil = Date.UTC(2026, 5, 8, 14);
    const tasks = [
      task({ id: "blocker", remainingMin: 0, reservedUntilMs: reservedUntil }),
      task({ id: "dependent", blockedBy: ["blocker"] }),
    ];
    const { blocks } = computeSchedule(MON_8AM, tasks, [], cfg);
    const starts = blocks.filter((b) => b.taskId === "dependent").map((b) => b.start);
    expect(starts.length).toBeGreaterThan(0);
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(reservedUntil);
  });

  it("rejects settings that would stall the engine", () => {
    expect(() => computeSchedule(MON_8AM, [task({ id: "a" })], [], { ...cfg, maxChunkMin: 0 })).toThrow();
  });
});

// --- Reflow (convex-test) ------------------------------------------------------------

const modules = import.meta.glob("../convex/**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  await t.mutation(api.seed.seedWorkspace, {});
  const dbs = await t.run((ctx) => ctx.db.query("databases").collect());
  const tasks = dbs.find((d) => d.isTaskSource);
  if (!tasks?.taskConfig) throw new Error("seed did not create a task source");
  const blocks = () => t.run((ctx) => ctx.db.query("timeBlocks").collect());
  const minutesFor = async (rowId: Id<"rows">) =>
    (await blocks()).filter((b) => b.taskRowId === rowId).reduce((sum, b) => sum + (b.end - b.start) / MIN_MS, 0);
  const estimateOf = async (row: Doc<"rows">) => {
    const value = row.properties[tasks.taskConfig?.estimatePropId ?? ""];
    if (!isNumber(value)) throw new Error(`${row.title} has no estimate`);
    return value;
  };
  return { t, tasks, blocks, minutesFor, estimateOf };
}

describe("runReflow", () => {
  it("counts a locked block once instead of booking the estimate again around it", async () => {
    const s = await seeded();
    const block = (await s.blocks()).find((b) => b.start > Date.now());
    if (!block) throw new Error("seed produced no future blocks");
    const row = await s.t.run((ctx) => ctx.db.get(block.taskRowId));
    if (!row) throw new Error("block's task missing");
    // What dragging a block does: move it and lock it.
    await s.t.mutation(api.timeBlocks.move, {
      blockId: block._id,
      start: block.start + DAY_MS,
      end: block.end + DAY_MS,
    });
    expect(await s.minutesFor(row._id)).toBe(await s.estimateOf(row));
  });

  it("treats an appointment that began a month ago and runs into next week as busy", async () => {
    const s = await seeded();
    const start = Date.now() - 30 * DAY_MS;
    const end = Date.now() + 7 * DAY_MS;
    await s.t.mutation(api.events.create, { title: "Long trip", start, end });
    const overlapping = (await s.blocks()).filter((b) => b.start < end && b.end > Date.now());
    expect(overlapping).toEqual([]);
  });

  it("does not schedule a task database whose page is in the trash", async () => {
    const s = await seeded();
    expect((await s.blocks()).length).toBeGreaterThan(0);
    if (!s.tasks.pageId) throw new Error("tasks database has no page");
    await s.t.mutation(api.pages.trash, { pageId: s.tasks.pageId });
    await s.t.mutation(api.scheduling.reflowNow, {});
    expect(await s.blocks()).toEqual([]);
  });

  it("flags a task whose planned time has all passed without it being marked done", async () => {
    const s = await seeded();
    const block = (await s.blocks())[0];
    // Move every block of that task into the past, as if the day had gone by.
    await s.t.run(async (ctx) => {
      const mine = (await ctx.db.query("timeBlocks").collect()).filter((b) => b.taskRowId === block.taskRowId);
      let cursor = Date.now() - 2 * DAY_MS;
      for (const b of mine) {
        const length = b.end - b.start;
        await ctx.db.patch(b._id, { start: cursor, end: cursor + length });
        cursor += length + 15 * MIN_MS;
      }
    });
    await s.t.mutation(api.scheduling.reflowNow, {});
    const state = await s.t.query(api.scheduling.getWarnings, {});
    // Stored as v.any(): name the shape the reflow writes.
    const warnings: SchedulerWarning[] = state.warnings;
    expect(warnings.find((w) => w.taskId === block.taskRowId)?.reason).toBe("time_used_up");
  });
});

describe("runReflow — Codex review of PR #54", () => {
  it("does not hold a dependent for a finished blocker's leftover locked block", async () => {
    const s = await seeded();
    const wiring = s.tasks.taskConfig;
    if (!wiring?.blockedByPropId) throw new Error("no dependency wiring");
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", s.tasks._id))
        .collect()
    );
    const blocker = rows.find((r) => r.title === "Plan Proxmox migration");
    const dependent = rows.find((r) => r.title === "Update DNS + reverse proxy");
    if (!blocker || !dependent) throw new Error("seed tasks missing");
    await s.t.mutation(api.rows.updateProperty, {
      rowId: dependent._id,
      propId: wiring.blockedByPropId,
      value: [blocker._id],
    });
    // Lock one of the blocker's blocks far ahead, then mark the blocker done.
    const block = (await s.blocks()).find((b) => b.taskRowId === blocker._id);
    if (!block) throw new Error("blocker has no block");
    const farAhead = Date.now() + 10 * DAY_MS;
    await s.t.mutation(api.timeBlocks.move, {
      blockId: block._id,
      start: farAhead,
      end: farAhead + (block.end - block.start),
    });
    const statusDefs: PropertyDef[] = s.tasks.properties;
    const done = statusDefs
      .find((p) => p.id === wiring.statusPropId)
      ?.options?.find((o) => o.group === "complete");
    if (!done) throw new Error("no complete status");
    await s.t.mutation(api.rows.updateProperty, { rowId: blocker._id, propId: wiring.statusPropId, value: done.id });
    const dependentStarts = (await s.blocks()).filter((b) => b.taskRowId === dependent._id).map((b) => b.start);
    expect(dependentStarts.length).toBeGreaterThan(0);
    expect(Math.min(...dependentStarts)).toBeLessThan(farAhead);
  });

  it("puts a restored task database back on the schedule", async () => {
    const s = await seeded();
    const before = (await s.blocks()).length;
    expect(before).toBeGreaterThan(0);
    if (!s.tasks.pageId) throw new Error("tasks database has no page");
    await s.t.mutation(api.pages.trash, { pageId: s.tasks.pageId });
    expect(await s.blocks()).toEqual([]);
    await s.t.mutation(api.pages.restore, { pageId: s.tasks.pageId });
    expect((await s.blocks()).length).toBe(before);
  });

  // Round 2: a task whose whole estimate sits in locked blocks must keep its deadline check.
  it("keeps the past-due warning and stripe when an overdue task's block is locked", async () => {
    const s = await seeded();
    const wiring = s.tasks.taskConfig;
    if (!wiring) throw new Error("no task wiring");
    const task = (await s.t.run((ctx) =>
      ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", s.tasks._id))
        .collect()
    )).find((r) => r.title === "Design app icon");
    if (!task) throw new Error("seed task missing");
    // Due yesterday (a calendar date, stored as UTC midnight): whatever is planned is late.
    const yesterday = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - DAY_MS;
    await s.t.mutation(api.rows.updateProperty, { rowId: task._id, propId: wiring.datePropId, value: { start: yesterday } });
    const reasonFor = async () => {
      const state = await s.t.query(api.scheduling.getWarnings, {});
      const warnings: SchedulerWarning[] = state.warnings;
      return warnings.find((w) => w.taskId === task._id)?.reason;
    };
    expect(await reasonFor()).toBe("past_due");
    const [block] = (await s.blocks()).filter((b) => b.taskRowId === task._id);
    // Lock it where it is, as a drag in place would.
    await s.t.mutation(api.timeBlocks.move, { blockId: block._id, start: block.start, end: block.end });
    expect(await reasonFor()).toBe("past_due");
    const [locked] = (await s.blocks()).filter((b) => b.taskRowId === task._id);
    expect(locked.locked).toBe(true);
    expect(locked.pastDue).toBe(true);
  });
});

describe("settings.update", () => {
  it("rejects invalid scheduling settings without saving them", async () => {
    const s = await seeded();
    await expect(s.t.mutation(api.settings.update, { maxChunkMin: 0 })).rejects.toThrow();
    const saved = await s.t.run((ctx) =>
      ctx.db
        .query("settings")
        .withIndex("by_key", (q) => q.eq("key", "global"))
        .unique()
    );
    expect(saved?.maxChunkMin).not.toBe(0);
  });
});
