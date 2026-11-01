import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { DEFAULT_SETTINGS } from "./lib/defaults";
import {
  PURGE_BATCH,
  RETENTION_DAYS,
  DEFAULT_BATCH_MIN,
  DEFAULT_SHOT_SEC,
  assertBatchMin,
  assertBundleId,
  assertCaptureDay,
  assertCount,
  assertDailyCap,
  assertDay,
  assertMediaPath,
  assertShotSec,
  assertSpan,
  assertText,
  assertTime,
  retentionCutoff,
} from "./lib/dayRecorder";

// WHAT: the Day Recorder's capture index — audio segments, transcripts, screenshots with
// their OCR text, recorder events, retention and settings. The media itself is on disk;
// the Electron main process writes it and calls these handlers. Every handler validates its
// arguments here, at the boundary. See docs/changes/2026-10-18-day-recorder/ (spec R2–R7, R14).

async function settingsDoc(ctx: { db: QueryCtx["db"] }) {
  return ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
}

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const s = await settingsDoc(ctx);
    return {
      enabled: s?.dayRecorderEnabled ?? false,
      paused: s?.dayRecorderPaused ?? false,
      denylist: s?.dayRecorderDenylist ?? [],
      // No cap set means the assistant does not run (spec F-cap; see assistant.capStatus).
      dailyCapUsd: s?.assistantDailyCapUsd ?? null,
      batchMin: s?.assistantBatchMin ?? DEFAULT_BATCH_MIN,
      shotSec: s?.dayRecorderShotSec ?? DEFAULT_SHOT_SEC,
    };
  },
});

// WHY not settings.update: that mutation re-plans the schedule on every save, and none of
// these settings affect the plan.
export const updateSettings = mutation({
  args: {
    enabled: v.optional(v.boolean()),
    paused: v.optional(v.boolean()),
    denylist: v.optional(v.array(v.string())),
    dailyCapUsd: v.optional(v.number()),
    batchMin: v.optional(v.number()),
    shotSec: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.denylist) args.denylist.forEach(assertBundleId);
    if (args.dailyCapUsd !== undefined) assertDailyCap(args.dailyCapUsd);
    if (args.batchMin !== undefined) assertBatchMin(args.batchMin);
    if (args.shotSec !== undefined) assertShotSec(args.shotSec);
    const patch = {
      ...(args.enabled !== undefined && { dayRecorderEnabled: args.enabled }),
      ...(args.paused !== undefined && { dayRecorderPaused: args.paused }),
      ...(args.denylist !== undefined && { dayRecorderDenylist: [...new Set(args.denylist)] }),
      ...(args.dailyCapUsd !== undefined && { assistantDailyCapUsd: args.dailyCapUsd }),
      ...(args.batchMin !== undefined && { assistantBatchMin: args.batchMin }),
      ...(args.shotSec !== undefined && { dayRecorderShotSec: args.shotSec }),
    };
    const existing = await settingsDoc(ctx);
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("settings", { ...DEFAULT_SETTINGS, ...patch });
  },
});

// WHY not a whole list from the page: a page saving the list it last rendered can undo an
// edit made since, by itself or another window, and an app just denied would be captured
// again (R4; Codex review of PR 3e-2). Each of these is one atomic change to the list as it
// is stored now.
async function editDenylist(ctx: MutationCtx, change: (list: string[]) => string[]) {
  const existing = await settingsDoc(ctx);
  const dayRecorderDenylist = change(existing?.dayRecorderDenylist ?? []);
  if (existing) await ctx.db.patch(existing._id, { dayRecorderDenylist });
  else await ctx.db.insert("settings", { ...DEFAULT_SETTINGS, dayRecorderDenylist });
}

export const addToDenylist = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    assertBundleId(id);
    await editDenylist(ctx, (list) => (list.includes(id) ? list : [...list, id]));
  },
});

export const removeFromDenylist = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    assertBundleId(id);
    await editDenylist(ctx, (list) => list.filter((entry) => entry !== id));
  },
});

export const logEvent = mutation({
  args: {
    at: v.number(),
    kind: v.union(
      v.literal("noticeGiven"),
      v.literal("noticeDeclined"),
      v.literal("imageSent"),
      v.literal("capError"),
      v.literal("capPaused")
    ),
    detail: v.optional(v.string()),
    screenshotId: v.optional(v.id("screenshots")),
  },
  // "purged" is not accepted here: only markPurged writes it, with the count it purged.
  handler: async (ctx, args) => {
    assertTime("at", args.at);
    if (args.detail !== undefined) assertText("Event detail", args.detail, 2000);
    if (args.kind === "imageSent" && !args.screenshotId) {
      throw new Error("An imageSent event must name the screenshot that was sent");
    }
    if (args.screenshotId && !(await ctx.db.get(args.screenshotId))) {
      throw new Error(`Screenshot ${args.screenshotId} does not exist`);
    }
    return ctx.db.insert("recorderEvents", args);
  },
});

export const addSegment = mutation({
  args: {
    day: v.string(),
    kind: v.union(v.literal("mic"), v.literal("system"), v.literal("call")),
    path: v.string(),
    start: v.number(),
    end: v.number(),
    noticeEventId: v.optional(v.id("recorderEvents")),
  },
  handler: async (ctx, args) => {
    assertDay(args.day);
    assertMediaPath(args.path, args.day);
    assertSpan(args.start, args.end);
    assertCaptureDay(args.day, args.start);
    // Spec R5 / F3: call audio reaches disk only after James gave the recording notice.
    // This is the last line of that guarantee, so it checks the event itself, not a flag.
    if (args.kind === "call") {
      const notice = args.noticeEventId ? await ctx.db.get(args.noticeEventId) : null;
      if (notice?.kind !== "noticeGiven") {
        throw new Error("Call audio needs a recording notice that was given before it is stored");
      }
    } else if (args.noticeEventId) {
      throw new Error("Only call audio carries a notice event");
    }
    return ctx.db.insert("captureSegments", { ...args, status: "closed" });
  },
});

export const setSegmentStatus = mutation({
  args: {
    segmentId: v.id("captureSegments"),
    status: v.union(v.literal("transcribed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    const segment = await ctx.db.get(args.segmentId);
    if (!segment) throw new Error(`Segment ${args.segmentId} does not exist`);
    if (segment.status === "purged") throw new Error("A purged segment cannot change status");
    await ctx.db.patch(args.segmentId, { status: args.status });
  },
});

// The transcription queue's input (plan PR 5): closed segments, oldest first.
const MAX_PENDING = 100;
export const pendingSegments = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`Invalid limit: ${limit}`);
    const n = Math.min(MAX_PENDING, limit ?? 20);
    const rows = await ctx.db
      .query("captureSegments")
      .withIndex("by_status_start", (q) => q.eq("status", "closed"))
      .take(n);
    return rows.map((r) => ({ _id: r._id, path: r.path, start: r.start, end: r.end }));
  },
});

export const addTranscript = mutation({
  args: {
    segmentId: v.id("captureSegments"),
    start: v.number(),
    end: v.number(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const segment = await ctx.db.get(args.segmentId);
    if (!segment) throw new Error(`Segment ${args.segmentId} does not exist`);
    assertSpan(args.start, args.end);
    assertText("Transcript", args.text);
    const id = await ctx.db.insert("transcripts", args);
    if (segment.status === "closed") await ctx.db.patch(args.segmentId, { status: "transcribed" });
    return id;
  },
});

export const addScreenshot = mutation({
  args: {
    day: v.string(),
    path: v.string(),
    takenAt: v.number(),
    appBundleId: v.optional(v.string()),
    ocrText: v.string(),
  },
  handler: async (ctx, args) => {
    assertDay(args.day);
    assertMediaPath(args.path, args.day);
    assertTime("takenAt", args.takenAt);
    assertCaptureDay(args.day, args.takenAt);
    if (args.appBundleId !== undefined) assertBundleId(args.appBundleId);
    assertText("OCR text", args.ocrText);
    return ctx.db.insert("screenshots", args);
  },
});

/** Media past retention that has not been purged yet, oldest first, at most PURGE_BATCH each. */
export const expiredMedia = query({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const cutoff = retentionCutoff(args.now);
    // WHY these indexes: both tables keep every row forever (the text outlives the media), so
    // a time-only scan would read the whole purged history on every run.
    const segments = await ctx.db
      .query("captureSegments")
      .withIndex("by_purged_start", (q) => q.eq("purgedAt", undefined).lt("start", cutoff))
      .take(PURGE_BATCH);
    const screenshots = await ctx.db
      .query("screenshots")
      .withIndex("by_purged_takenAt", (q) => q.eq("purgedAt", undefined).lt("takenAt", cutoff))
      .take(PURGE_BATCH);
    return {
      segments: segments.map((s) => ({ _id: s._id, path: s.path })),
      screenshots: screenshots.map((s) => ({ _id: s._id, path: s.path })),
    };
  },
});

/**
 * Record that the main process deleted these files. Refuses anything not yet expired, so a
 * bad caller cannot mark live media gone. Transcripts and OCR text are untouched.
 */
export const markPurged = mutation({
  args: {
    segmentIds: v.array(v.id("captureSegments")),
    screenshotIds: v.array(v.id("screenshots")),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    const count = args.segmentIds.length + args.screenshotIds.length;
    assertCount("purge size", count);
    if (count > 2 * PURGE_BATCH) throw new Error(`Purge at most ${2 * PURGE_BATCH} items at once`);
    const cutoff = retentionCutoff(args.at);
    const notExpired = () => new Error(`Refusing to purge media younger than ${RETENTION_DAYS} days`);
    for (const id of args.segmentIds) {
      const s = await ctx.db.get(id);
      if (!s) throw new Error(`Segment ${id} does not exist`);
      if (s.start >= cutoff) throw notExpired();
      await ctx.db.patch(id, { status: "purged", purgedAt: args.at });
    }
    for (const id of args.screenshotIds) {
      const s = await ctx.db.get(id);
      if (!s) throw new Error(`Screenshot ${id} does not exist`);
      if (s.takenAt >= cutoff) throw notExpired();
      await ctx.db.patch(id, { purgedAt: args.at });
    }
    if (count > 0) await ctx.db.insert("recorderEvents", { at: args.at, kind: "purged", count });
  },
});
