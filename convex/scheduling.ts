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
  type SchedulerWarning,
} from "./lib/scheduler";
import { validateSchedulerConfig } from "./lib/validation";
import { isPageHidden } from "./lib/pageTree";
import type { DateValue, PropertyDef } from "./lib/types";
import { DEFAULT_SETTINGS } from "./lib/defaults";
import { isNumber } from "./lib/predicates";

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
  // Fail before touching any block if the stored settings are out of range.
  validateSchedulerConfig({ ...s, tzOffsetMin: tz });
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

  // --- Busy time: fixed (non-all-day) events still running or ahead of us, however long
  // ago they began (a multi-week trip used to stop counting after 14 days).
  const horizonEnd = now + (s.horizonDays + 1) * DAY_MS;
  const events = await ctx.db
    .query("events")
    .withIndex("by_end", (q) => q.gt("end", now))
    .collect();
  const busy: Interval[] = events
    .filter((e) => !e.allDay && e.start < horizonEnd)
    .map((e) => ({ start: Math.max(e.start, now), end: e.end }));

  // --- Existing blocks: freeze the past, keep locks, clear the rest.
  // Started/past blocks are history and count as worked (option A). A locked future block is
  // a promise the engine keeps: it reserves its time AND counts toward the estimate, or the
  // next reflow would book the whole estimate again around it.
  const allBlocks = await ctx.db.query("timeBlocks").collect();
  const loggedMin = new Map<string, number>();
  const pastMin = new Map<string, number>();
  const hasFutureBlock = new Set<string>();
  const reservedEnd = new Map<string, number>();
  const add = (m: Map<string, number>, id: string, n: number) => m.set(id, (m.get(id) ?? 0) + n);
  for (const b of allBlocks) {
    const minutes = (b.end - b.start) / MIN_MS;
    if (b.start <= now || b.locked) {
      add(loggedMin, b.taskRowId, minutes);
      reservedEnd.set(b.taskRowId, Math.max(reservedEnd.get(b.taskRowId) ?? 0, b.end));
      if (b.start <= now) add(pastMin, b.taskRowId, minutes);
      if (b.end > now) {
        busy.push({ start: Math.max(now, b.start), end: b.end });
        hasFutureBlock.add(b.taskRowId);
      }
    } else {
      await ctx.db.delete(b._id);
    }
  }
  const usedUp: SchedulerWarning[] = [];
  // Tasks marked done: their leftover reservations must not hold anyone up.
  const doneIds = new Set<string>();

  // --- Tasks from every task-source database
  const dbs = await ctx.db.query("databases").collect();
  const tasks: SchedulerTask[] = [];
  const taskDb = new Map<string, Id<"databases">>();
  for (const db of dbs) {
    if (!db.isTaskSource || !db.taskConfig) continue;
    // A task database in the trash (or under a trashed page) is out of sight: no blocks.
    if (db.pageId && (await isPageHidden(ctx.db, db.pageId))) continue;
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
      if (group === "complete") {
        doneIds.add(row._id);
        continue;
      }
      const estimate = p[db.taskConfig.estimatePropId];
      if (!isNumber(estimate) || estimate <= 0) continue;
      const remaining = estimate - (loggedMin.get(row._id) ?? 0);
      if (remaining <= 0) {
        // Every planned minute has passed and the task is still open: say so, rather than
        // let it drop off the plan silently (option A).
        if ((pastMin.get(row._id) ?? 0) >= estimate && !hasFutureBlock.has(row._id)) {
          usedUp.push({ taskId: row._id, title: row.title, unscheduledMin: 0, reason: "time_used_up" });
        }
        continue;
      }

      const dateVal = p[db.taskConfig.datePropId] as DateValue | undefined;
      let dueMs: number | undefined;
      if (dateVal && isNumber(dateVal.start)) {
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

  // Not before an unfinished blocker's started or locked work ends, even when it has nothing
  // left to plan. A blocker marked done holds nobody, whatever it still has reserved.
  for (const t of tasks) {
    const holding = (t.blockedBy ?? []).filter((id) => !doneIds.has(id));
    t.earliestMs = Math.max(now, ...holding.map((id) => reservedEnd.get(id) ?? now));
  }
  const result = computeSchedule(now, tasks, busy, cfg);
  const warnings = [...result.warnings, ...usedUp];
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
    await ctx.db.patch(state._id, { warnings, lastRun: now });
  } else {
    await ctx.db.insert("schedulerState", {
      key: "global",
      warnings,
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
