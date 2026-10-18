import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator, type PaginationOptions } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { PropertyDef } from "./lib/types";
import { isPageHidden } from "./lib/pageTree";
import { changeProperties, deleteRowAndReferences, type PropertyBag } from "./lib/rowProperties";
import { runReflow } from "./scheduling";
import {
  MAX_BLOCK_MS,
  assertCost,
  assertCount,
  assertDay,
  assertDraftBody,
  assertIssueRef,
  assertTime,
  assertTitle,
  rowFingerprint,
} from "./lib/dayRecorder";

// WHAT: what the Day Recorder's assistant may do inside Geekspace, and how it is undone.
// A commitment becomes a task plus a LOCKED time block (the scheduler keeps locked blocks
// where they are, so no scheduler change is needed). Anything external is only a draft.
// Every effect is logged in assistantActions, and one undo reverses a whole group unless
// James has changed it since. The model's proposals reach this file already parsed in the
// main process; these validators are still the trust boundary.
// See docs/changes/2026-10-18-day-recorder/ (spec R8, R10–R12).

const MAX_ACTIONS_PER_CALL = 20;
const MAX_ESTIMATE_MIN = 40 * 60;
// The most items one page may ask for. Lists are paginated, never truncated: a capped list
// would silently drop later actions from the review (Codex review of PR 2, round 2).
const MAX_PAGE = 200;

function assertPage(opts: PaginationOptions): void {
  if (!Number.isInteger(opts.numItems) || opts.numItems < 1 || opts.numItems > MAX_PAGE) {
    throw new Error(`Page size must be 1–${MAX_PAGE}, got ${opts.numItems}`);
  }
}

const source = {
  sourceSegmentId: v.optional(v.id("captureSegments")),
  sourceScreenshotId: v.optional(v.id("screenshots")),
};

const proposal = v.union(
  v.object({
    type: v.literal("createTask"),
    title: v.string(),
    estimateMin: v.number(),
    dueMs: v.optional(v.number()),
    block: v.optional(v.object({ start: v.number(), end: v.number() })),
    ...source,
  }),
  v.object({
    type: v.literal("draftLinear"),
    issueRef: v.string(),
    body: v.string(),
    ...source,
  })
);

/** The task database the assistant writes to: the oldest visible task source. */
async function taskDatabase(ctx: MutationCtx): Promise<Doc<"databases">> {
  const dbs = await ctx.db.query("databases").collect();
  for (const db of dbs) {
    if (!db.isTaskSource || !db.taskConfig) continue;
    if (db.pageId && (await isPageHidden(ctx.db, db.pageId))) continue;
    return db;
  }
  throw new Error("No task database: mark a database as a task source first");
}

export const applyActions = mutation({
  args: { actions: v.array(proposal), tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (args.actions.length > MAX_ACTIONS_PER_CALL) {
      throw new Error(`At most ${MAX_ACTIONS_PER_CALL} actions per call`);
    }
    const now = Date.now();
    // Validate every proposal before writing anything. A throw also rolls the whole
    // mutation back, but checking first keeps the error about the input, not a half-write.
    for (const a of args.actions) {
      if (a.sourceSegmentId && !(await ctx.db.get(a.sourceSegmentId))) {
        throw new Error(`Source segment ${a.sourceSegmentId} does not exist`);
      }
      if (a.sourceScreenshotId && !(await ctx.db.get(a.sourceScreenshotId))) {
        throw new Error(`Source screenshot ${a.sourceScreenshotId} does not exist`);
      }
      if (a.type === "createTask") {
        assertTitle(a.title);
        if (!Number.isFinite(a.estimateMin) || a.estimateMin <= 0 || a.estimateMin > MAX_ESTIMATE_MIN) {
          throw new Error(`Estimate must be 1–${MAX_ESTIMATE_MIN} minutes, got ${a.estimateMin}`);
        }
        if (a.dueMs !== undefined) assertTime("due date", a.dueMs);
        if (a.block) {
          const { start, end } = a.block;
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            throw new Error("Invalid time block: it must end after it starts");
          }
          if (end - start > MAX_BLOCK_MS) throw new Error("Invalid time block: longer than a working day");
          if (end <= now) throw new Error("Invalid time block: it is already over");
        }
      } else {
        assertIssueRef(a.issueRef);
        assertDraftBody(a.body);
      }
    }

    const groupIds: string[] = [];
    // Where each task's group came from, for its createTask row written after the reflow.
    const taskSources = new Map<Id<"rows">, { sourceSegmentId?: Id<"captureSegments">; sourceScreenshotId?: Id<"screenshots"> }>();
    let touchedTasks = false;
    for (const a of args.actions) {
      const { sourceSegmentId, sourceScreenshotId } = a;
      if (a.type === "draftLinear") {
        const draftId = await ctx.db.insert("externalDrafts", {
          target: "linear",
          issueRef: a.issueRef,
          body: a.body,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("assistantActions", {
          kind: "draftLinear",
          at: now,
          groupId: draftId,
          draftId,
          sourceSegmentId,
          sourceScreenshotId,
        });
        groupIds.push(draftId);
        continue;
      }

      const db = await taskDatabase(ctx);
      const config = db.taskConfig;
      if (!config) throw new Error(`"${db.name}" has no task configuration`);
      const props: PropertyDef[] = db.properties;
      const titleProp = props.find((p) => p.type === "title");
      if (!titleProp) throw new Error(`"${db.name}" has no title property`);
      const todo = props
        .find((p) => p.id === config.statusPropId)
        ?.options?.find((o) => o.group === "todo");
      const changes: PropertyBag = {
        [titleProp.id]: a.title,
        [config.estimatePropId]: a.estimateMin,
        ...(a.dueMs !== undefined && { [config.datePropId]: { start: a.dueMs, includeTime: true } }),
        ...(todo && { [config.statusPropId]: todo.id }),
      };
      const rowId = await ctx.db.insert("rows", {
        databaseId: db._id,
        title: "",
        properties: {},
        order: now,
        updatedAt: now,
      });
      const fresh = await ctx.db.get(rowId);
      if (!fresh) throw new Error(`Row ${rowId} vanished right after it was created`);
      // Through the shared writer, so the title is denormalized and every value validated.
      await changeProperties(ctx, fresh, db, changes);
      touchedTasks = true;

      if (a.block) {
        const blockId = await ctx.db.insert("timeBlocks", {
          taskRowId: rowId,
          databaseId: db._id,
          start: a.block.start,
          end: a.block.end,
          locked: true,
        });
        await ctx.db.insert("assistantActions", {
          kind: "createBlock",
          at: now,
          groupId: rowId,
          blockId,
          taskRowId: rowId,
          start: a.block.start,
          end: a.block.end,
          sourceSegmentId,
          sourceScreenshotId,
        });
      }
      taskSources.set(rowId, { sourceSegmentId, sourceScreenshotId });
      groupIds.push(rowId);
    }
    if (touchedTasks) await runReflow(ctx, args.tzOffsetMin);

    // Fingerprint the tasks only after the reflow, so undo compares against the state the
    // assistant actually left behind.
    for (const [rowId, sources] of taskSources) {
      const row = await ctx.db.get(rowId);
      if (!row) throw new Error(`Task ${rowId} vanished during the reflow`);
      await ctx.db.insert("assistantActions", {
        kind: "createTask",
        at: now,
        groupId: rowId,
        rowId,
        rowFingerprint: rowFingerprint(row),
        ...sources,
      });
    }
    return { groupIds };
  },
});

/**
 * Why an action can no longer be undone, or null when it still can. `group` is every action
 * of the same proposal: a task's blocks are judged against the blocks the group logged.
 */
async function changedSince(
  ctx: MutationCtx,
  action: Doc<"assistantActions">,
  group: Doc<"assistantActions">[]
): Promise<string | null> {
  switch (action.kind) {
    case "createTask": {
      const row = await ctx.db.get(action.rowId);
      if (!row) return null; // already gone: nothing of James's to lose
      if (rowFingerprint(row) !== action.rowFingerprint) return "the task was changed since";
      // Deleting the task deletes every block it has. Unlocked blocks are the scheduler's to
      // redo, and the group's own blocks are checked below. Any OTHER locked block is one
      // James dragged or locked by hand (Codex review of PR 2, round 1).
      const logged = new Set(group.flatMap((a) => (a.kind === "createBlock" ? [a.blockId] : [])));
      const blocks = await ctx.db
        .query("timeBlocks")
        .withIndex("by_task", (q) => q.eq("taskRowId", action.rowId))
        .collect();
      if (blocks.some((b) => b.locked && !logged.has(b._id))) return "a time block for the task was changed since";
      return null;
    }
    case "createBlock": {
      const block = await ctx.db.get(action.blockId);
      if (!block) {
        // Gone with its task is fine. Gone while the task remains means it was unlocked and
        // re-planned, or deleted: a change of James's either way.
        return (await ctx.db.get(action.taskRowId)) ? "the time block was changed since" : null;
      }
      if (block.start !== action.start || block.end !== action.end || !block.locked) {
        return "the time block was changed since";
      }
      return null;
    }
    case "draftLinear": {
      const draft = await ctx.db.get(action.draftId);
      if (draft && draft.status !== "pending") return `the draft was already ${draft.status} (changed since)`;
      return null;
    }
  }
}

export const undo = mutation({
  args: { actionId: v.id("assistantActions"), tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error(`Action ${args.actionId} does not exist`);
    if (action.undoneAt !== undefined) throw new Error("This action is already undone");
    const group = await ctx.db
      .query("assistantActions")
      .withIndex("by_group", (q) => q.eq("groupId", action.groupId))
      .collect();
    // Check the whole group first: a partial undo would leave a block without its task.
    for (const member of group) {
      const reason = await changedSince(ctx, member, group);
      if (reason) throw new Error(`Can't undo: ${reason}. Undo it by hand instead.`);
    }
    let touchedTasks = false;
    const now = Date.now();
    for (const member of group) {
      if (member.kind === "createTask") {
        const { touchedTaskSource } = await deleteRowAndReferences(ctx, member.rowId);
        touchedTasks ||= touchedTaskSource;
      } else if (member.kind === "createBlock") {
        // Usually already gone with its task; deleting what is left is idempotent.
        if (await ctx.db.get(member.blockId)) await ctx.db.delete(member.blockId);
      } else if (await ctx.db.get(member.draftId)) {
        await ctx.db.patch(member.draftId, { status: "discarded", updatedAt: now });
      }
      await ctx.db.patch(member._id, { undoneAt: now });
    }
    if (touchedTasks) await runReflow(ctx, args.tzOffsetMin);
  },
});

export const listActions = query({
  args: { since: v.number(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    assertTime("since", args.since);
    assertPage(args.paginationOpts);
    return ctx.db
      .query("assistantActions")
      .withIndex("by_at", (q) => q.gte("at", args.since))
      .paginate(args.paginationOpts);
  },
});

const draftStatus = v.union(v.literal("pending"), v.literal("approved"), v.literal("sent"), v.literal("discarded"));
type DraftStatus = Doc<"externalDrafts">["status"];
// Drafts only move forward. "sent" is final: nothing that left Geekspace can be unsent.
const NEXT = {
  pending: ["approved", "discarded"],
  approved: ["sent", "discarded"],
  sent: [],
  discarded: [],
} satisfies Record<DraftStatus, readonly DraftStatus[]>;

export const listDrafts = query({
  args: { status: draftStatus, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    assertPage(args.paginationOpts);
    return ctx.db
      .query("externalDrafts")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .paginate(args.paginationOpts);
  },
});

export const setDraftStatus = mutation({
  args: { draftId: v.id("externalDrafts"), status: draftStatus },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft) throw new Error(`Draft ${args.draftId} does not exist`);
    const allowed: readonly DraftStatus[] = NEXT[draft.status];
    if (!allowed.includes(args.status)) {
      throw new Error(`Cannot move a draft from ${draft.status} to ${args.status}`);
    }
    await ctx.db.patch(args.draftId, { status: args.status, updatedAt: Date.now() });
  },
});

export const recordUsage = mutation({
  args: { day: v.string(), inputTokens: v.number(), outputTokens: v.number(), costUsd: v.number() },
  handler: async (ctx, args) => {
    assertDay(args.day);
    assertCount("input tokens", args.inputTokens);
    assertCount("output tokens", args.outputTokens);
    assertCost(args.costUsd);
    const row = await ctx.db
      .query("assistantUsage")
      .withIndex("by_day", (q) => q.eq("day", args.day))
      .unique();
    if (row) {
      await ctx.db.patch(row._id, {
        inputTokens: row.inputTokens + args.inputTokens,
        outputTokens: row.outputTokens + args.outputTokens,
        costUsd: row.costUsd + args.costUsd,
      });
    } else {
      await ctx.db.insert("assistantUsage", args);
    }
  },
});

/** Spend against the daily cap. No cap set reads as reached: the assistant must not run. */
export const capStatus = query({
  args: { day: v.string() },
  handler: async (ctx, args) => {
    assertDay(args.day);
    const settings = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    const capUsd = settings?.assistantDailyCapUsd ?? null;
    const usage = await ctx.db
      .query("assistantUsage")
      .withIndex("by_day", (q) => q.eq("day", args.day))
      .unique();
    const spentUsd = usage?.costUsd ?? 0;
    return { capUsd, spentUsd, reached: capUsd === null || spentUsd >= capUsd };
  },
});
