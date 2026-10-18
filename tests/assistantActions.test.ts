import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// WHAT: the Day Recorder assistant's writes into Geekspace. A commitment becomes a task plus
// a LOCKED time block, every effect is logged in assistantActions, the scheduler keeps the
// block, and one undo removes the whole group unless James has changed it since.
// See docs/changes/2026-10-18-day-recorder/ (spec R10, R11, R12).
// SYNTHETIC: every transcript line and title below is invented for the test.

const modules = import.meta.glob("../convex/**/*.ts");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

async function seeded() {
  const t = convexTest(schema, modules);
  await t.mutation(api.seed.seedWorkspace, {});
  return t;
}

// "I'll send the deck by Thursday": one task due in three days, one hour blocked tomorrow.
function commitment() {
  const blockStart = Date.now() + DAY_MS;
  return {
    type: "createTask" as const,
    title: "Send the deck",
    estimateMin: 60,
    dueMs: Date.now() + 3 * DAY_MS,
    block: { start: blockStart, end: blockStart + HOUR_MS },
  };
}

describe("assistant.applyActions", () => {
  it("turns a commitment into one task, one locked block and two logged actions", async () => {
    const t = await seeded();
    const before = await t.run((ctx) => ctx.db.query("rows").collect());
    const result = await t.mutation(api.assistant.applyActions, { actions: [commitment()] });

    const rows = await t.run((ctx) => ctx.db.query("rows").collect());
    const created = rows.filter((r) => !before.some((b) => b._id === r._id));
    expect(created.map((r) => r.title)).toEqual(["Send the deck"]);

    const blocks = await t.run((ctx) => ctx.db.query("timeBlocks").collect());
    const mine = blocks.filter((b) => b.taskRowId === created[0]._id);
    expect(mine).toHaveLength(1);
    expect(mine[0].locked).toBe(true);

    const actions = await t.run((ctx) => ctx.db.query("assistantActions").collect());
    expect(actions.map((a) => a.kind).sort()).toEqual(["createBlock", "createTask"]);
    expect(new Set(actions.map((a) => a.groupId)).size).toBe(1);
    expect(result.groupIds).toHaveLength(1);
  });

  it("leaves the assistant's block where it was put when the scheduler re-plans", async () => {
    const t = await seeded();
    const action = commitment();
    await t.mutation(api.assistant.applyActions, { actions: [action] });
    await t.mutation(api.scheduling.reflowNow, {});
    const blocks = await t.run((ctx) => ctx.db.query("timeBlocks").collect());
    const kept = blocks.filter((b) => b.start === action.block.start && b.end === action.block.end);
    expect(kept).toHaveLength(1);
    expect(kept[0].locked).toBe(true);
    // The estimate is fully covered by the locked block, so nothing else is booked for it.
    expect(blocks.filter((b) => b.taskRowId === kept[0].taskRowId)).toHaveLength(1);
  });

  it("rejects a block that ends before it starts, writing nothing", async () => {
    const t = await seeded();
    const bad = commitment();
    bad.block = { start: bad.block.end, end: bad.block.start };
    await expect(t.mutation(api.assistant.applyActions, { actions: [bad] })).rejects.toThrow(/block/i);
    expect(await t.run((ctx) => ctx.db.query("assistantActions").collect())).toEqual([]);
  });

  it("stores a Linear update as a pending draft and sends nothing", async () => {
    const t = await seeded();
    await t.mutation(api.assistant.applyActions, {
      actions: [{ type: "draftLinear", issueRef: "GEEK-12", body: "Deck is drafted, sending Thursday." }],
    });
    const drafts = await t.run((ctx) => ctx.db.query("externalDrafts").collect());
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("pending");
    expect(drafts[0].target).toBe("linear");
  });
});

describe("assistant.undo", () => {
  async function applied() {
    const t = await seeded();
    const { groupIds } = await t.mutation(api.assistant.applyActions, { actions: [commitment()] });
    const actions = await t.run((ctx) => ctx.db.query("assistantActions").collect());
    const task = actions.find((a) => a.kind === "createTask");
    if (!task || task.kind !== "createTask") throw new Error("no createTask action");
    return { t, groupId: groupIds[0], actionId: task._id, rowId: task.rowId };
  }

  it("removes the task and its block in one undo, and marks both actions undone", async () => {
    const { t, actionId, rowId } = await applied();
    await t.mutation(api.assistant.undo, { actionId });
    expect(await t.run((ctx) => ctx.db.get(rowId))).toBeNull();
    const blocks = await t.run((ctx) => ctx.db.query("timeBlocks").collect());
    expect(blocks.filter((b) => b.taskRowId === rowId)).toEqual([]);
    const actions = await t.run((ctx) => ctx.db.query("assistantActions").collect());
    expect(actions.every((a) => a.undoneAt !== undefined)).toBe(true);
  });

  it("refuses when James has edited the task since, and changes nothing", async () => {
    const { t, actionId, rowId } = await applied();
    const row = await t.run((ctx) => ctx.db.get(rowId));
    if (!row) throw new Error("task missing");
    const db = await t.run((ctx) => ctx.db.get(row.databaseId));
    const titleProp = db?.properties.find((p: { type: string }) => p.type === "title");
    if (!titleProp) throw new Error("task database has no title property");
    await t.mutation(api.rows.updateProperty, { rowId, propId: titleProp.id, value: "Send the deck (v2)" });

    await expect(t.mutation(api.assistant.undo, { actionId })).rejects.toThrow(/changed/i);
    expect(await t.run((ctx) => ctx.db.get(rowId))).not.toBeNull();
    const actions = await t.run((ctx) => ctx.db.query("assistantActions").collect());
    expect(actions.every((a) => a.undoneAt === undefined)).toBe(true);
  });

  it("refuses when James has moved the block since", async () => {
    const { t, actionId, rowId } = await applied();
    const block = (await t.run((ctx) => ctx.db.query("timeBlocks").collect())).find((b) => b.taskRowId === rowId);
    if (!block) throw new Error("block missing");
    await t.mutation(api.timeBlocks.move, { blockId: block._id, start: block.start + HOUR_MS, end: block.end + HOUR_MS });
    await expect(t.mutation(api.assistant.undo, { actionId })).rejects.toThrow(/changed/i);
  });

  it("undoes a group only once", async () => {
    const { t, actionId } = await applied();
    await t.mutation(api.assistant.undo, { actionId });
    await expect(t.mutation(api.assistant.undo, { actionId })).rejects.toThrow(/already undone/i);
  });

  it("discards a pending Linear draft on undo", async () => {
    const t = await seeded();
    await t.mutation(api.assistant.applyActions, {
      actions: [{ type: "draftLinear", issueRef: "GEEK-12", body: "Status update." }],
    });
    const action = (await t.run((ctx) => ctx.db.query("assistantActions").collect()))[0];
    await t.mutation(api.assistant.undo, { actionId: action._id });
    const drafts = await t.run((ctx) => ctx.db.query("externalDrafts").collect());
    expect(drafts[0].status).toBe("discarded");
  });
});

describe("assistant drafts", () => {
  async function draft() {
    const t = await seeded();
    await t.mutation(api.assistant.applyActions, {
      actions: [{ type: "draftLinear", issueRef: "GEEK-12", body: "Status update." }],
    });
    const id: Id<"externalDrafts"> = (await t.run((ctx) => ctx.db.query("externalDrafts").collect()))[0]._id;
    return { t, id };
  }

  it("only moves a draft forward: pending → approved → sent", async () => {
    const { t, id } = await draft();
    await expect(t.mutation(api.assistant.setDraftStatus, { draftId: id, status: "sent" })).rejects.toThrow(
      /pending.*sent/i
    );
    await t.mutation(api.assistant.setDraftStatus, { draftId: id, status: "approved" });
    await t.mutation(api.assistant.setDraftStatus, { draftId: id, status: "sent" });
    await expect(
      t.mutation(api.assistant.setDraftStatus, { draftId: id, status: "discarded" })
    ).rejects.toThrow(/sent.*discarded/i);
  });
});

describe("assistant usage and the daily cap", () => {
  it("does not run without a cap: no cap set reads as reached", async () => {
    const t = await seeded();
    const cap = await t.query(api.assistant.capStatus, { day: "2026-10-18" });
    expect(cap).toMatchObject({ capUsd: null, reached: true });
  });

  it("adds usage up across batches and reports the cap reached at the limit", async () => {
    const t = await seeded();
    await t.mutation(api.dayRecorder.updateSettings, { dailyCapUsd: 1 });
    await t.mutation(api.assistant.recordUsage, { day: "2026-10-18", inputTokens: 1000, outputTokens: 200, costUsd: 0.6 });
    expect(await t.query(api.assistant.capStatus, { day: "2026-10-18" })).toMatchObject({ spentUsd: 0.6, reached: false });
    await t.mutation(api.assistant.recordUsage, { day: "2026-10-18", inputTokens: 900, outputTokens: 100, costUsd: 0.4 });
    expect(await t.query(api.assistant.capStatus, { day: "2026-10-18" })).toMatchObject({ spentUsd: 1, reached: true });
    // Another day starts from zero.
    expect(await t.query(api.assistant.capStatus, { day: "2026-10-19" })).toMatchObject({ spentUsd: 0, reached: false });
  });

  it("rejects negative or non-finite usage", async () => {
    const t = await seeded();
    await expect(
      t.mutation(api.assistant.recordUsage, { day: "2026-10-18", inputTokens: -1, outputTokens: 0, costUsd: 0 })
    ).rejects.toThrow();
    await expect(
      t.mutation(api.assistant.recordUsage, { day: "2026-10-18", inputTokens: 1, outputTokens: 0, costUsd: Number.NaN })
    ).rejects.toThrow();
  });
});
