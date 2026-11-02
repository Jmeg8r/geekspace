import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { PaginationResult } from "convex/server";

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

// The same commitment with no block: the scheduler books its time instead.
function taskOnly() {
  const { type, title, estimateMin, dueMs } = commitment();
  return { type, title, estimateMin, dueMs };
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

  // Codex review of PR 2, round 1: James's edits to blocks the assistant did not log.
  it("refuses when James has locked a block the scheduler booked for the task", async () => {
    const t = await seeded();
    const { groupIds } = await t.mutation(api.assistant.applyActions, { actions: [taskOnly()] });
    const actions = await t.run((ctx) => ctx.db.query("assistantActions").collect());
    expect(actions.map((a) => a.kind)).toEqual(["createTask"]);
    const booked = (await t.run((ctx) => ctx.db.query("timeBlocks").collect())).filter(
      (b) => b.taskRowId === groupIds[0]
    );
    expect(booked.length).toBeGreaterThan(0);
    expect(booked.every((b) => !b.locked)).toBe(true);
    await t.mutation(api.timeBlocks.toggleLock, { blockId: booked[0]._id });
    await expect(t.mutation(api.assistant.undo, { actionId: actions[0]._id })).rejects.toThrow(/changed/i);
    expect(await t.run((ctx) => ctx.db.query("timeBlocks").collect())).not.toEqual([]);
  });

  it("still undoes a task whose only blocks are the scheduler's own, unedited", async () => {
    const t = await seeded();
    const { groupIds } = await t.mutation(api.assistant.applyActions, { actions: [taskOnly()] });
    const action = (await t.run((ctx) => ctx.db.query("assistantActions").collect()))[0];
    await t.mutation(api.assistant.undo, { actionId: action._id });
    const rowId = groupIds[0];
    const left = (await t.run((ctx) => ctx.db.query("timeBlocks").collect())).filter((b) => b.taskRowId === rowId);
    expect(left).toEqual([]);
  });

  it("refuses when James unlocked the assistant's block and the scheduler replaced it", async () => {
    const { t, actionId, rowId } = await applied();
    const block = (await t.run((ctx) => ctx.db.query("timeBlocks").collect())).find((b) => b.taskRowId === rowId);
    if (!block) throw new Error("block missing");
    await t.mutation(api.timeBlocks.toggleLock, { blockId: block._id });
    // Whether the engine kept, moved or replaced the block, the edit must block the undo.
    await expect(t.mutation(api.assistant.undo, { actionId })).rejects.toThrow(/changed/i);
    expect(await t.run((ctx) => ctx.db.get(rowId))).not.toBeNull();
  });

  it("refuses when the assistant's block is gone but its task is still there", async () => {
    const { t, actionId, rowId } = await applied();
    const block = (await t.run((ctx) => ctx.db.query("timeBlocks").collect())).find((b) => b.taskRowId === rowId);
    if (!block) throw new Error("block missing");
    await t.run((ctx) => ctx.db.delete(block._id));
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

// Codex review of PR 2, round 2: lists page through everything instead of stopping at a cap.
describe("assistant lists paginate", () => {
  it("returns every action across pages, none twice", async () => {
    const t = await seeded();
    const since = Date.now() - 1;
    const proposals = Array.from({ length: 15 }, (_, i) => ({
      type: "draftLinear" as const,
      issueRef: `GEEK-${i + 1}`,
      body: `Update ${i + 1}`,
    }));
    await t.mutation(api.assistant.applyActions, { actions: proposals });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const page: PaginationResult<Doc<"assistantActions">> = await t.query(api.assistant.listActions, {
        since,
        paginationOpts: { numItems: 4, cursor },
      });
      seen.push(...page.page.map((a) => a._id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toHaveLength(15);
    expect(new Set(seen).size).toBe(15);
  });

  it("returns every pending draft across pages", async () => {
    const t = await seeded();
    const proposals = Array.from({ length: 7 }, (_, i) => ({
      type: "draftLinear" as const,
      issueRef: `GEEK-${i + 1}`,
      body: `Update ${i + 1}`,
    }));
    await t.mutation(api.assistant.applyActions, { actions: proposals });
    const first = await t.query(api.assistant.listDrafts, { status: "pending", paginationOpts: { numItems: 5, cursor: null } });
    expect(first.isDone).toBe(false);
    const second = await t.query(api.assistant.listDrafts, {
      status: "pending",
      paginationOpts: { numItems: 5, cursor: first.continueCursor },
    });
    expect([...first.page, ...second.page].map((d) => d.issueRef).sort()).toEqual(proposals.map((p) => p.issueRef).sort());
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

  it("adds settled calls up and reports the cap reached at the limit", async () => {
    const t = await seeded();
    await t.mutation(api.dayRecorder.updateSettings, { dailyCapUsd: 1 });
    const call = async (costUsd: number) => {
      const requestId = await t.mutation(api.assistant.beginRequest, { day: "2026-10-18", reservedUsd: costUsd, transcriptIds: [], screenshotIds: [] });
      await t.mutation(api.assistant.settleRequest, { requestId: requestId!, costUsd, inputTokens: 1000, outputTokens: 100, proposals: [] });
    };
    await call(0.6);
    expect(await t.query(api.assistant.capStatus, { day: "2026-10-18" })).toMatchObject({ spentUsd: 0.6, reached: false });
    await call(0.4);
    expect(await t.query(api.assistant.capStatus, { day: "2026-10-18" })).toMatchObject({ spentUsd: 1, reached: true });
    // Another day starts from zero.
    expect(await t.query(api.assistant.capStatus, { day: "2026-10-19" })).toMatchObject({ spentUsd: 0, reached: false });
  });

  it("rejects negative or non-finite usage", async () => {
    const t = await seeded();
    await t.mutation(api.dayRecorder.updateSettings, { dailyCapUsd: 1 });
    const requestId = await t.mutation(api.assistant.beginRequest, { day: "2026-10-18", reservedUsd: 0.1, transcriptIds: [], screenshotIds: [] });
    await expect(
      t.mutation(api.assistant.settleRequest, { requestId: requestId!, costUsd: 0, inputTokens: -1, outputTokens: 0, proposals: [] })
    ).rejects.toThrow();
    await expect(
      t.mutation(api.assistant.settleRequest, { requestId: requestId!, costUsd: Number.NaN, inputTokens: 1, outputTokens: 0, proposals: [] })
    ).rejects.toThrow();
  });
});

// Plan PR 6b: a send to Linear that fails puts its draft back in the queue; the Linear code
// reads the draft it claimed by id.
describe("assistant drafts, the send", () => {
  async function aDraft() {
    const t = await seeded();
    const id = await t.run((ctx) =>
      ctx.db.insert("externalDrafts", { target: "linear", issueRef: "ENG-42", body: "SYNTHETIC", status: "pending", createdAt: 1, updatedAt: 1 })
    );
    return { t, id };
  }

  it("an approved draft whose send failed goes back to pending only through releaseDraft", async () => {
    const { t, id } = await aDraft();
    await t.mutation(api.assistant.setDraftStatus, { draftId: id, status: "approved" });
    // Codex 6b r1: the step back must keep whether the send is in doubt, so it has one door.
    await expect(t.mutation(api.assistant.setDraftStatus, { draftId: id, status: "pending" })).rejects.toThrow(/approved to pending/);
    await t.mutation(api.assistant.releaseDraft, { draftId: id, deliveryUnknown: false });
    expect((await t.query(api.assistant.draft, { draftId: id }))?.status).toBe("pending");
  });

  it("a claim moves a waiting draft to approved and fixes its comment id for every later claim", async () => {
    const { t, id } = await aDraft();
    const first = await t.mutation(api.assistant.claimDraft, { draftId: id, commentId: "00000000-0000-4000-8000-000000000001" });
    expect(first).toEqual({ issueRef: "ENG-42", body: "SYNTHETIC", commentId: "00000000-0000-4000-8000-000000000001", deliveryUnknown: false });
    await expect(t.mutation(api.assistant.claimDraft, { draftId: id, commentId: "00000000-0000-4000-8000-000000000002" })).rejects.toThrow(/approved/);
    await t.mutation(api.assistant.releaseDraft, { draftId: id, deliveryUnknown: true });
    const again = await t.mutation(api.assistant.claimDraft, { draftId: id, commentId: "00000000-0000-4000-8000-000000000002" });
    expect(again).toMatchObject({ commentId: "00000000-0000-4000-8000-000000000001", deliveryUnknown: true });
    // Once in doubt, a later failure that is certain does not clear it: only sending does.
    await t.mutation(api.assistant.releaseDraft, { draftId: id, deliveryUnknown: false });
    expect(await t.query(api.assistant.draft, { draftId: id })).toMatchObject({ status: "pending", deliveryUnknown: true });
  });

  it("a claim refuses a comment id that is not a UUID, and a release refuses a draft that is not approved", async () => {
    const { t, id } = await aDraft();
    await expect(t.mutation(api.assistant.claimDraft, { draftId: id, commentId: "not-a-uuid" })).rejects.toThrow(/comment id/);
    await expect(t.mutation(api.assistant.releaseDraft, { draftId: id, deliveryUnknown: false })).rejects.toThrow(/pending/);
  });

  it("reads one draft by id", async () => {
    const { t, id } = await aDraft();
    expect(await t.query(api.assistant.draft, { draftId: id })).toMatchObject({ issueRef: "ENG-42", body: "SYNTHETIC" });
  });
});

