import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { SchedulerWarning } from "../convex/lib/scheduler";

// WHAT: the reflow does only the work it needs, and calendar reads are bounded and complete.
// See docs/changes/2026-10-15-scheduler-dst-perf/.

const modules = import.meta.glob("../convex/**/*.ts");
const DAY_MS = 86_400_000;

async function seeded() {
  const t = convexTest(schema, modules);
  await t.mutation(api.seed.seedWorkspace, {});
  const dbs = await t.run((ctx) => ctx.db.query("databases").collect());
  const tasks = dbs.find((d) => d.isTaskSource);
  if (!tasks?.taskConfig) throw new Error("seed did not create a task source");
  const wiring = tasks.taskConfig;
  const rows = () =>
    t.run((ctx) =>
      ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", tasks._id))
        .collect()
    );
  const blocks = () => t.run((ctx) => ctx.db.query("timeBlocks").collect());
  const blockIds = async () => (await blocks()).map((b) => b._id).sort();
  return { t, tasks, wiring, rows, blocks, blockIds };
}

describe("reflow gating", () => {
  it("does not re-plan when only a task's title changes", async () => {
    const s = await seeded();
    const before = await s.blockIds();
    const [task] = await s.rows();
    await s.t.mutation(api.rows.updateProperty, { rowId: task._id, propId: "title", value: "Renamed, no re-plan" });
    expect(await s.blockIds()).toEqual(before);
  });

  it("still re-plans when a task's status changes", async () => {
    const s = await seeded();
    const block = (await s.blocks()).find((b) => b.start > Date.now());
    if (!block) throw new Error("no future block");
    const statusDefs = s.tasks.properties as Array<{ id: string; options?: Array<{ id: string; group?: string }> }>;
    const done = statusDefs.find((p) => p.id === s.wiring.statusPropId)?.options?.find((o) => o.group === "complete");
    if (!done) throw new Error("no complete status");
    await s.t.mutation(api.rows.updateProperty, { rowId: block.taskRowId, propId: s.wiring.statusPropId, value: done.id });
    expect((await s.blocks()).filter((b) => b.taskRowId === block.taskRowId && b.start > Date.now())).toEqual([]);
  });
});

describe("in-place reflow", () => {
  it("keeps identical blocks (same ids) when nothing changed", async () => {
    const s = await seeded();
    const before = await s.blocks();
    await s.t.mutation(api.scheduling.reflowNow, {});
    const after = await s.blocks();
    expect(after.map((b) => b._id).sort()).toEqual(before.map((b) => b._id).sort());
    const shape = (bs: typeof before) => bs.map((b) => `${b.taskRowId}:${b.start}:${b.end}`).sort();
    expect(shape(after)).toEqual(shape(before));
  });
});

describe("warnings", () => {
  it("show the current task title without a re-plan", async () => {
    const s = await seeded();
    const task = (await s.rows()).find((r) => r.title === "Design app icon");
    if (!task) throw new Error("seed task missing");
    const yesterday = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - DAY_MS;
    await s.t.mutation(api.rows.updateProperty, { rowId: task._id, propId: s.wiring.datePropId, value: { start: yesterday } });
    await s.t.mutation(api.rows.updateProperty, { rowId: task._id, propId: "title", value: "Icon, renamed" });
    const state = await s.t.query(api.scheduling.getWarnings, {});
    const warnings: SchedulerWarning[] = state.warnings;
    expect(warnings.find((w) => w.taskId === task._id)?.title).toBe("Icon, renamed");
  });
});

describe("calendar range queries", () => {
  it("list an event that began 40 days ago and is still running", async () => {
    const s = await seeded();
    const now = Date.now();
    await s.t.mutation(api.events.create, { title: "Sabbatical", start: now - 40 * DAY_MS, end: now + 3 * DAY_MS });
    const listed = await s.t.query(api.events.listRange, { start: now, end: now + 7 * DAY_MS });
    expect(listed.map((e) => e.title)).toContain("Sabbatical");
  });

  it("do not list blocks of a task database in the trash", async () => {
    const s = await seeded();
    const block = (await s.blocks()).find((b) => b.start > Date.now());
    if (!block || !s.tasks.pageId) throw new Error("no future block or page");
    // Locked, so the block survives the reflow that trashing triggers.
    await s.t.mutation(api.timeBlocks.move, { blockId: block._id, start: block.start, end: block.end });
    await s.t.mutation(api.pages.trash, { pageId: s.tasks.pageId });
    const listed = await s.t.query(api.timeBlocks.listRange, { start: block.start - DAY_MS, end: block.end + DAY_MS });
    expect(listed.map((b) => b._id)).not.toContain(block._id);
  });
});
