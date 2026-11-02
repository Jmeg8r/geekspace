import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { proposal, type Proposal } from "./lib/assistantProposal";
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

/** Apply proposals as one write: validated first, then written and logged for undo. */
async function applyAll(ctx: MutationCtx, args: { actions: Proposal[]; tzOffsetMin?: number }) {
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
}

export const applyActions = mutation({
  args: { actions: v.array(proposal), tzOffsetMin: v.optional(v.number()) },
  handler: (ctx, args) => applyAll(ctx, args),
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
// "sent" and "discarded" are final: nothing that left Geekspace can be unsent. The one step
// back, a failed send from approved to pending, is releaseDraft's, which keeps whether the
// send is in doubt.
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

/**
 * Where a screenshot's image is, for an image request (spec R9); null once the image is purged
 * or the row is gone. Never the OCR text: the request sends the image itself.
 */
export const screenshot = query({
  args: { screenshotId: v.id("screenshots") },
  handler: async (ctx, { screenshotId }) => {
    const row = await ctx.db.get(screenshotId);
    if (!row || row.purgedAt !== undefined) return null;
    return { _id: row._id, path: row.path, takenAt: row.takenAt, ...(row.appBundleId !== undefined && { appBundleId: row.appBundleId }) };
  },
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * James approved a draft: claim it for the Linear send (pending → approved), so two clicks
 * can't both send it. The comment id is fixed at the first claim and kept for every later
 * one (Codex review of PR 6b, round 1).
 */
export const claimDraft = mutation({
  args: { draftId: v.id("externalDrafts"), commentId: v.string() },
  handler: async (ctx, { draftId, commentId }) => {
    if (!UUID_V4.test(commentId)) throw new Error("The comment id must be a UUID v4");
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new Error(`Draft ${draftId} does not exist`);
    if (draft.status !== "pending") throw new Error(`Cannot move a draft from ${draft.status} to approved`);
    const id = draft.commentId ?? commentId;
    await ctx.db.patch(draftId, { status: "approved", commentId: id, updatedAt: Date.now() });
    return { issueRef: draft.issueRef, body: draft.body, commentId: id, deliveryUnknown: draft.deliveryUnknown === true };
  },
});

/** The send did not finish: back in the queue. A send in doubt stays in doubt until it is sent. */
export const releaseDraft = mutation({
  args: { draftId: v.id("externalDrafts"), deliveryUnknown: v.boolean() },
  handler: async (ctx, { draftId, deliveryUnknown }) => {
    const draft = await ctx.db.get(draftId);
    if (!draft) throw new Error(`Draft ${draftId} does not exist`);
    if (draft.status !== "approved") throw new Error(`Cannot move a draft from ${draft.status} to pending`);
    await ctx.db.patch(draftId, { status: "pending", deliveryUnknown: draft.deliveryUnknown === true || deliveryUnknown, updatedAt: Date.now() });
  },
});

/** One draft, for the Linear send that claimed it (electron/linearDrafts.mjs). */
export const draft = query({
  args: { draftId: v.id("externalDrafts") },
  handler: async (ctx, args) => ctx.db.get(args.draftId),
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
    const spentUsd = (usage?.costUsd ?? 0) + (await reservedUsd(ctx, args.day));
    return { capUsd, spentUsd, reached: capUsd === null || spentUsd >= capUsd };
  },
});

// What the assistant reads and spends (plan PR 6a; Codex review of PR 6a, round 1). Each item
// carries whether it was read; a call reserves its worst case against the cap before it is
// made; settling records its real cost, marks exactly the items it read, and keeps its
// proposals, in one write. A time watermark skipped transcripts written late and resent part
// of a batch; this can't.
const MAX_INPUT_ROWS = 200;
// How many pages one batch may read past rows too long for the cap (electron/dayAssistant.mjs).
const MAX_CURSOR_PAGES = 10;
// A call still in flight after this was abandoned (a crash, a quit mid-call): it stays counted
// at its reservation, and its items are read again. Past the SDK's own request timeout.
const ABANDON_MS = 30 * 60_000;

async function reservedUsd(ctx: QueryCtx, day: string): Promise<number> {
  const inFlight = await ctx.db
    .query("assistantRequests")
    .withIndex("by_day_status", (q) => q.eq("day", day).eq("status", "inFlight"))
    .collect();
  return inFlight.reduce((sum, r) => sum + r.reservedUsd, 0);
}

type Usage = { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; costUsd: number };
const NO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

async function addUsage(ctx: MutationCtx, day: string, u: Usage) {
  const row = await ctx.db
    .query("assistantUsage")
    .withIndex("by_day", (q) => q.eq("day", day))
    .unique();
  if (row) {
    await ctx.db.patch(row._id, {
      inputTokens: row.inputTokens + u.inputTokens,
      outputTokens: row.outputTokens + u.outputTokens,
      cacheWriteTokens: (row.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
      cacheReadTokens: (row.cacheReadTokens ?? 0) + u.cacheReadTokens,
      costUsd: row.costUsd + u.costUsd,
    });
  } else {
    await ctx.db.insert("assistantUsage", { day, ...u });
  }
}

async function globalSettings(ctx: QueryCtx) {
  return ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
}

// Where a page of unread rows ended: its last row's time, and the ids already returned at that
// exact time, so a row sharing it is neither skipped nor returned twice (Codex #6a r4).
const after = v.optional(v.object({ at: v.number(), ids: v.array(v.string()) }));

/** A page of rows from `from` on, past `cursor`; and the cursor its last row leaves. */
function page<R extends { _id: string }>(rows: R[], limit: number, timeOf: (r: R) => number, cursor?: { at: number; ids: string[] }) {
  const seen = new Set(cursor?.ids ?? []);
  const fresh = rows.filter((r) => !(cursor && timeOf(r) === cursor.at && seen.has(r._id))).slice(0, limit);
  const last = fresh.at(-1);
  const tied = last ? fresh.filter((r) => timeOf(r) === timeOf(last)).map((r) => r._id) : [];
  const ids = last && cursor && timeOf(last) === cursor.at ? [...cursor.ids, ...tied] : tied;
  return { rows: fresh, done: fresh.length < limit, after: last ? { at: timeOf(last), ids } : cursor };
}

/**
 * Unread transcripts and screen text captured since `since`, oldest first, a page of each.
 * `transcriptAfter` / `screenshotAfter` continue after an earlier page: a page whose rows are
 * all too long for what is left of the cap must not hide the rows behind it (Codex #6a r4).
 */
export const unread = query({
  args: { since: v.number(), limit: v.number(), transcriptAfter: after, screenshotAfter: after },
  handler: async (ctx, { since, limit, transcriptAfter, screenshotAfter }) => {
    assertTime("since", since);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INPUT_ROWS) {
      throw new Error(`The limit must be 1–${MAX_INPUT_ROWS}, got ${limit}`);
    }
    for (const cursor of [transcriptAfter, screenshotAfter]) {
      if (!cursor) continue;
      assertTime("cursor", cursor.at);
      if (cursor.ids.length > MAX_INPUT_ROWS * MAX_CURSOR_PAGES) throw new Error("The cursor names too many rows");
    }
    // Ties at the cursor's time are fetched again and filtered: at most the ids it names more.
    const tFrom = Math.max(since, transcriptAfter?.at ?? since);
    const sFrom = Math.max(since, screenshotAfter?.at ?? since);
    const tRows = await ctx.db
      .query("transcripts")
      .withIndex("by_read_start", (q) => q.eq("readAt", undefined).gte("start", tFrom))
      .take(limit + (transcriptAfter?.ids.length ?? 0));
    const sRows = await ctx.db
      .query("screenshots")
      .withIndex("by_read_takenAt", (q) => q.eq("readAt", undefined).gte("takenAt", sFrom))
      .take(limit + (screenshotAfter?.ids.length ?? 0));
    const tPage = page(tRows, limit, (r) => r.start, transcriptAfter);
    const sPage = page(sRows, limit, (r) => r.takenAt, screenshotAfter);
    const transcripts = tPage.rows;
    const screenshots = sPage.rows;
    return {
      transcriptsDone: tPage.done,
      screenshotsDone: sPage.done,
      ...(tPage.after && { transcriptAfter: tPage.after }),
      ...(sPage.after && { screenshotAfter: sPage.after }),
      transcripts: transcripts.map((r) => ({
        _id: r._id,
        segmentId: r.segmentId,
        start: r.start,
        end: r.end,
        text: r.text,
        ...(r.readChars !== undefined && { readChars: r.readChars }),
      })),
      screenshots: screenshots.map((r) => ({
        _id: r._id,
        takenAt: r.takenAt,
        ocrText: r.ocrText,
        ...(r.appBundleId !== undefined && { appBundleId: r.appBundleId }),
        ...(r.readChars !== undefined && { readChars: r.readChars }),
      })),
    };
  },
});

function assertEnds(name: string, ends: number[] | undefined, count: number) {
  if (ends === undefined) return;
  if (ends.length !== count) throw new Error(`${name} ends must match its items: ${ends.length} for ${count}`);
  for (const end of ends) {
    if (!Number.isInteger(end) || end < 0) throw new Error(`${name} ends must be whole character counts, got ${end}`);
  }
}

/** How far an item has now been read: done (readAt) once its part reaches the end. */
function readPatch(length: number, readChars: number | undefined, end: number | undefined, now: number) {
  if (end === undefined || end >= length) return { readAt: now };
  return { readChars: Math.max(readChars ?? 0, end) };
}

/** Where the assistant starts reading: the first value given is kept. */
export const ensureStart = mutation({
  args: { at: v.number() },
  handler: async (ctx, { at }) => {
    assertTime("start", at);
    const settings = await globalSettings(ctx);
    if (!settings) throw new Error("No settings yet: open Geekspace once first");
    if (settings.assistantSince !== undefined) return settings.assistantSince;
    await ctx.db.patch(settings._id, { assistantSince: at });
    return at;
  },
});

/**
 * Reserve a call's worst case. Null when it doesn't fit what is left of the day's cap (or no
 * cap is set): the call must not be made. Calls abandoned in flight are closed here, counted
 * at their reservations.
 */
export const beginRequest = mutation({
  args: {
    day: v.string(),
    reservedUsd: v.number(),
    transcriptIds: v.array(v.id("transcripts")),
    screenshotIds: v.array(v.id("screenshots")),
    transcriptEnds: v.optional(v.array(v.number())),
    screenshotEnds: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    assertDay(args.day);
    assertCost(args.reservedUsd);
    assertEnds("Transcript", args.transcriptEnds, args.transcriptIds.length);
    assertEnds("Screenshot", args.screenshotEnds, args.screenshotIds.length);
    if (args.transcriptIds.length > MAX_INPUT_ROWS || args.screenshotIds.length > MAX_INPUT_ROWS) {
      throw new Error(`At most ${MAX_INPUT_ROWS} items of each kind per call`);
    }
    const now = Date.now();
    for (const r of await ctx.db.query("assistantRequests").withIndex("by_status", (q) => q.eq("status", "inFlight")).collect()) {
      if (now - r.at < ABANDON_MS) continue;
      await addUsage(ctx, r.day, { ...NO_TOKENS, costUsd: r.reservedUsd });
      await ctx.db.patch(r._id, { status: "done" });
    }
    const settings = await globalSettings(ctx);
    const capUsd = settings?.assistantDailyCapUsd ?? null;
    if (capUsd === null) return null;
    const usage = await ctx.db
      .query("assistantUsage")
      .withIndex("by_day", (q) => q.eq("day", args.day))
      .unique();
    const committed = (usage?.costUsd ?? 0) + (await reservedUsd(ctx, args.day));
    if (committed + args.reservedUsd > capUsd) return null;
    return ctx.db.insert("assistantRequests", { ...args, at: now, status: "inFlight" });
  },
});

/**
 * The call answered: its real cost replaces its reservation, exactly its items are marked
 * read, and its proposals are kept to be applied. Sent again after a lost answer, a no-op.
 */
export const settleRequest = mutation({
  args: {
    requestId: v.id("assistantRequests"),
    costUsd: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    // Absent means the reply reported none.
    cacheWriteTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    proposals: v.array(proposal),
  },
  handler: async (ctx, args) => {
    const usage = {
      costUsd: args.costUsd,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cacheWriteTokens: args.cacheWriteTokens ?? 0,
      cacheReadTokens: args.cacheReadTokens ?? 0,
    };
    assertCost(usage.costUsd);
    assertCount("input tokens", usage.inputTokens);
    assertCount("output tokens", usage.outputTokens);
    assertCount("cache write tokens", usage.cacheWriteTokens);
    assertCount("cache read tokens", usage.cacheReadTokens);
    if (args.proposals.length > MAX_ACTIONS_PER_CALL) throw new Error(`At most ${MAX_ACTIONS_PER_CALL} proposals per call`);
    const req = await ctx.db.get(args.requestId);
    if (!req) throw new Error(`Request ${args.requestId} does not exist`);
    if (req.status !== "inFlight") return;
    await addUsage(ctx, req.day, usage);
    const now = Date.now();
    for (const [i, id] of req.transcriptIds.entries()) {
      const row = await ctx.db.get(id);
      if (row) await ctx.db.patch(id, readPatch(row.text.length, row.readChars, req.transcriptEnds?.[i], now));
    }
    for (const [i, id] of req.screenshotIds.entries()) {
      const row = await ctx.db.get(id);
      if (row) await ctx.db.patch(id, readPatch(row.ocrText.length, row.readChars, req.screenshotEnds?.[i], now));
    }
    await ctx.db.patch(args.requestId, {
      ...usage,
      status: args.proposals.length > 0 ? "settled" : "done",
      proposals: args.proposals.map((p) => ({ proposal: p, state: "pending" as const })),
    });
  },
});

/** The API refused the call before doing any work: nothing was paid, its items are read again. */
export const failRequest = mutation({
  args: { requestId: v.id("assistantRequests") },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get(requestId);
    if (req?.status === "inFlight") await ctx.db.patch(requestId, { status: "done" });
  },
});

/**
 * The call failed in a way that doesn't prove nothing was done (a dropped connection, a
 * timeout, a server error): it stays charged at its reservation, and its items are read again
 * (Codex review of PR 6a, round 2).
 */
export const abandonRequest = mutation({
  args: { requestId: v.id("assistantRequests") },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get(requestId);
    if (req?.status !== "inFlight") return;
    await addUsage(ctx, req.day, { ...NO_TOKENS, costUsd: req.reservedUsd });
    await ctx.db.patch(requestId, { status: "done" });
  },
});

/** Calls not finished: in flight, or with proposals still to apply. */
export const openRequests = query({
  args: {},
  handler: async (ctx) => {
    const inFlight = await ctx.db.query("assistantRequests").withIndex("by_status", (q) => q.eq("status", "inFlight")).collect();
    const settled = await ctx.db.query("assistantRequests").withIndex("by_status", (q) => q.eq("status", "settled")).collect();
    return [...inFlight, ...settled].map((r) => ({ _id: r._id, status: r.status, at: r.at, proposals: r.proposals ?? [] }));
  },
});

async function resolveProposal(
  ctx: MutationCtx,
  requestId: Id<"assistantRequests">,
  index: number,
  state: "applied" | "refused",
  tzOffsetMin?: number
) {
  const req = await ctx.db.get(requestId);
  if (!req) throw new Error(`Request ${requestId} does not exist`);
  const proposals = req.proposals ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= proposals.length) throw new Error(`No proposal ${index} in this request`);
  if (proposals[index].state !== "pending") return;
  if (state === "applied") await applyAll(ctx, { actions: [proposals[index].proposal], tzOffsetMin });
  const next = proposals.map((p, i) => (i === index ? { ...p, state } : p));
  await ctx.db.patch(requestId, { proposals: next, ...(next.every((p) => p.state !== "pending") && { status: "done" as const }) });
}

/** Apply one kept proposal, once. Throws (and changes nothing) when Geekspace won't take it. */
export const applyProposal = mutation({
  args: { requestId: v.id("assistantRequests"), index: v.number(), tzOffsetMin: v.optional(v.number()) },
  handler: (ctx, { requestId, index, tzOffsetMin }) => resolveProposal(ctx, requestId, index, "applied", tzOffsetMin),
});

/** A kept proposal Geekspace refused: it is not tried again. */
export const refuseProposal = mutation({
  args: { requestId: v.id("assistantRequests"), index: v.number() },
  handler: (ctx, { requestId, index }) => resolveProposal(ctx, requestId, index, "refused"),
});
