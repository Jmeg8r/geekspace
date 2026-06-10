import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  computeSchedule,
  calendarDateToLocalMs,
  DAY_MS,
  MIN_MS,
  type Interval,
  type SchedulerConfig,
  type SchedulerTask,
} from "./lib/scheduler";
import type { DateValue, PropertyDef } from "./lib/types";
import { DEFAULT_SETTINGS } from "./lib/defaults";

// WHAT: Gathers tasks + busy time and recomputes every engine-owned time block.
// WHY: this is the "Notion Calendar magic" — every mutation that touches tasks,
// events, blocks, or settings calls runReflow so the whole plan stays
// consistent without the user ever asking for it.

export async function getMergedSettings(ctx: { db: QueryCtx["db"] }) {
  const doc = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
  return { doc, merged: { ...DEFAULT_SETTINGS, ...(doc ?? {}) } };
}

export async function runReflow(ctx: MutationCtx, tzOffsetMin?: number) {
  const { doc, merged: s } = await getMergedSettings(ctx);
  const tz = tzOffsetMin ?? s.tzOffsetMin;
  // Remember the client's offset for reflows triggered without one.
  if (tzOffsetMin !== undefined) {
    if (doc && doc.tzOffsetMin !== tzOffsetMin) {
      await ctx.db.patch(doc._id, { tzOffsetMin });
    } else if (!doc) {
      await ctx.db.insert("settings", { ...DEFAULT_SETTINGS, tzOffsetMin });
    }
  }

  const now = Date.now();
  const cfg: SchedulerConfig = {
    workDays: s.workDays,
    dayStartMin: s.dayStartMin,
    dayEndMin: s.dayEndMin,
    minChunkMin: s.minChunkMin,
    maxChunkMin: s.maxChunkMin,
    bufferMin: s.bufferMin,
    horizonDays: s.horizonDays,
    granularityMin: s.granularityMin,
    tzOffsetMin: tz,
  };

  // --- Busy time: fixed (non-all-day) events still ahead of us
  const horizonEnd = now + (s.horizonDays + 1) * DAY_MS;
  const events = await ctx.db
    .query("events")
    .withIndex("by_start", (q) => q.gte("start", now - 14 * DAY_MS))
    .collect();
  const busy: Interval[] = events
    .filter((e) => !e.allDay && e.end > now && e.start < horizonEnd)
    .map((e) => ({ start: Math.max(e.start, now), end: e.end }));

  // --- Existing blocks: freeze the past, respect locks, clear the rest
  const allBlocks = await ctx.db.query("timeBlocks").collect();
  const loggedMin = new Map<string, number>();
  for (const b of allBlocks) {
    if (b.start <= now) {
      // Started/past blocks are immutable history; they count as planned work.
      loggedMin.set(
        b.taskRowId,
        (loggedMin.get(b.taskRowId) ?? 0) + (b.end - b.start) / MIN_MS
      );
      if (b.end > now) busy.push({ start: now, end: b.end });
    } else if (b.locked) {
      busy.push({ start: b.start, end: b.end });
    } else {
      await ctx.db.delete(b._id);
    }
  }

  // --- Tasks from every task-source database
  const dbs = await ctx.db.query("databases").collect();
  const tasks: SchedulerTask[] = [];
  const taskDb = new Map<string, Id<"databases">>();
  for (const db of dbs) {
    if (!db.isTaskSource || !db.taskConfig) continue;
    const props = db.properties as PropertyDef[];
    const statusProp = props.find((p) => p.id === db.taskConfig!.statusPropId);
    const priorityProp = props.find((p) => p.id === db.taskConfig!.priorityPropId);
    const rows = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", db._id))
      .collect();
    for (const row of rows) {
      const p = (row.properties ?? {}) as Record<string, unknown>;
      const statusVal = p[db.taskConfig.statusPropId];
      const group =
        statusProp?.options?.find((o) => o.id === statusVal)?.group ?? "todo";
      if (group === "complete") continue;
      const estimate = p[db.taskConfig.estimatePropId];
      if (typeof estimate !== "number" || estimate <= 0) continue;
      const remaining = estimate - (loggedMin.get(row._id) ?? 0);
      if (remaining <= 0) continue;

      const dateVal = p[db.taskConfig.datePropId] as DateValue | undefined;
      let dueMs: number | undefined;
      if (dateVal && typeof dateVal.start === "number") {
        dueMs = dateVal.includeTime
          ? (dateVal.end ?? dateVal.start)
          : calendarDateToLocalMs(dateVal.end ?? dateVal.start, tz, s.dayEndMin);
      }

      let priority = 2; // medium default
      const prVal = p[db.taskConfig.priorityPropId];
      const prIdx = priorityProp?.options?.findIndex((o) => o.id === prVal) ?? -1;
      if (prIdx >= 0) priority = prIdx;

      const blockedByPropId = db.taskConfig.blockedByPropId;
      const rawBlockers = blockedByPropId ? p[blockedByPropId] : undefined;
      const blockedBy = Array.isArray(rawBlockers) ? (rawBlockers as string[]) : undefined;

      tasks.push({
        id: row._id,
        title: row.title,
        remainingMin: remaining,
        dueMs,
        priority,
        blockedBy,
      });
      taskDb.set(row._id, db._id);
    }
  }

  const result = computeSchedule(now, tasks, busy, cfg);
  for (const b of result.blocks) {
    await ctx.db.insert("timeBlocks", {
      taskRowId: b.taskId as Id<"rows">,
      databaseId: taskDb.get(b.taskId)!,
      start: b.start,
      end: b.end,
      locked: false,
      pastDue: b.pastDue,
    });
  }

  const state = await ctx.db
    .query("schedulerState")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
  if (state) {
    await ctx.db.patch(state._id, { warnings: result.warnings, lastRun: now });
  } else {
    await ctx.db.insert("schedulerState", {
      key: "global",
      warnings: result.warnings,
      lastRun: now,
    });
  }
}

/** Manual/initial reflow — the app calls this on launch with the real tz offset. */
export const reflowNow = mutation({
  args: { tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await runReflow(ctx, args.tzOffsetMin);
  },
});

export const getWarnings = query({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db
      .query("schedulerState")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    return state ?? { warnings: [], lastRun: 0 };
  },
});
