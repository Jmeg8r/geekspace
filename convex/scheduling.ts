import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
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

// Longest a block can run: chunks are capped at a day (validateSchedulerConfig), and a
// dragged block keeps its length. Two days back finds every block still running.
const RUNNING_LOOKBACK_MS = 2 * DAY_MS;

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

  // --- Existing blocks. Started/past blocks are history and count as worked (option A). A
  // locked future block is a promise the engine keeps: it reserves its time AND counts toward
  // the estimate. Unlocked future blocks are the engine's to redo; they are reused below when
  // the new plan has the same block, so ids stay stable.
  // WHY bounded reads: the table only grows. Only blocks still running or ahead are read here
  // (a block never runs longer than RUNNING_LOOKBACK_MS); each open task's history is read
  // through by_task in the task loop. See docs/changes/2026-10-15-scheduler-dst-perf/.
  const current = await ctx.db
    .query("timeBlocks")
    .withIndex("by_start", (q) => q.gte("start", now - RUNNING_LOOKBACK_MS))
    .collect();
  const replaceable: Doc<"timeBlocks">[] = [];
  const hasFutureBlock = new Set<string>();
  const reservedEnd = new Map<string, number>();
  // Locked blocks still ahead, per task: kept as placed, but their deadline is still checked.
  const lockedAhead = new Map<string, Doc<"timeBlocks">[]>();
  for (const b of current) {
    if (b.end <= now) continue; // finished: history, counted per task below
    if (b.start > now && !b.locked) {
      replaceable.push(b);
      continue;
    }
    busy.push({ start: Math.max(now, b.start), end: b.end });
    hasFutureBlock.add(b.taskRowId);
    reservedEnd.set(b.taskRowId, Math.max(reservedEnd.get(b.taskRowId) ?? 0, b.end));
    if (b.start > now) lockedAhead.set(b.taskRowId, [...(lockedAhead.get(b.taskRowId) ?? []), b]);
  }
  const usedUp: SchedulerWarning[] = [];
  // Open tasks with a locked block after their due date, by id → title.
  const lateLocked = new Map<string, string>();

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
      // Done tasks stay out of the engine, so they hold nobody up whatever they still reserve.
      if (group === "complete") continue;
      const estimate = p[db.taskConfig.estimatePropId];
      if (!isNumber(estimate) || estimate <= 0) continue;
      const dateVal = p[db.taskConfig.datePropId] as DateValue | undefined;
      let dueMs: number | undefined;
      if (dateVal && isNumber(dateVal.start)) {
        dueMs = dateVal.includeTime
          ? (dateVal.end ?? dateVal.start)
          : calendarDateToLocalMs(dateVal.end ?? dateVal.start, tz, s.dayEndMin);
      }
      // Locked blocks are not re-planned, so check their deadline here: keep each block's
      // past-due stripe true to the current due date, and warn if any lands after it, even
      // when locked blocks cover the whole estimate and the engine never sees the task.
      for (const b of lockedAhead.get(row._id) ?? []) {
        const late = dueMs !== undefined && b.end > dueMs;
        if (late !== b.pastDue) await ctx.db.patch(b._id, { pastDue: late });
        if (late) lateLocked.set(row._id, row.title);
      }

      // Minutes already worked (every started block) plus minutes promised by locked blocks.
      const history = await ctx.db
        .query("timeBlocks")
        .withIndex("by_task", (q) => q.eq("taskRowId", row._id))
        .collect();
      const pastMinutes = history
        .filter((b) => b.start <= now)
        .reduce((sum, b) => sum + (b.end - b.start) / MIN_MS, 0);
      const lockedMinutes = (lockedAhead.get(row._id) ?? []).reduce(
        (sum, b) => sum + (b.end - b.start) / MIN_MS,
        0
      );
      const remaining = estimate - pastMinutes - lockedMinutes;
      // Every planned minute has passed and the task is still open: say so, rather than let
      // it drop off the plan silently (option A).
      if (remaining <= 0 && !hasFutureBlock.has(row._id)) {
        if (pastMinutes >= estimate) {
          usedUp.push({ taskId: row._id, title: row.title, unscheduledMin: 0, reason: "time_used_up" });
        }
        continue;
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
        // Fully reserved tasks (locked or running blocks cover the estimate) go in with 0:
        // they place nothing but stay in the dependency graph.
        remainingMin: Math.max(remaining, 0),
        reservedUntilMs: reservedEnd.get(row._id),
        dueMs,
        priority,
        blockedBy,
      });
      taskDb.set(row._id, db._id);
    }
  }

  const result = computeSchedule(now, tasks, busy, cfg);
  const warned = new Set(result.warnings.map((w) => w.taskId));
  const lateLockedWarnings: SchedulerWarning[] = [...lateLocked]
    .filter(([taskId]) => !warned.has(taskId))
    .map(([taskId, title]) => ({ taskId, title, unscheduledMin: 0, reason: "past_due" }));
  const warnings = [...result.warnings, ...lateLockedWarnings, ...usedUp];
  // In place: keep a block the new plan repeats exactly, insert what is new, delete the rest.
  // The result is the block set a full rewrite would leave, without churning ids.
  const placement = (taskId: string, start: number, end: number) => `${taskId}|${start}|${end}`;
  const reusable = new Map(replaceable.map((b) => [placement(b.taskRowId, b.start, b.end), b]));
  for (const b of result.blocks) {
    const databaseId = taskDb.get(b.taskId)!;
    const same = reusable.get(placement(b.taskId, b.start, b.end));
    if (same) {
      reusable.delete(placement(b.taskId, b.start, b.end));
      if (same.pastDue !== b.pastDue || same.databaseId !== databaseId) {
        await ctx.db.patch(same._id, { pastDue: b.pastDue, databaseId });
      }
      continue;
    }
    await ctx.db.insert("timeBlocks", {
      taskRowId: b.taskId as Id<"rows">,
      databaseId,
      start: b.start,
      end: b.end,
      locked: false,
      pastDue: b.pastDue,
    });
  }
  for (const stale of reusable.values()) await ctx.db.delete(stale._id);

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
    if (!state) return { warnings: [], lastRun: 0 };
    // Titles come from the rows now, so renaming a task needs no re-plan to show up here.
    const stored: SchedulerWarning[] = state.warnings;
    const warnings = await Promise.all(
      stored.map(async (w) => {
        const rowId = ctx.db.normalizeId("rows", w.taskId);
        const row = rowId ? await ctx.db.get(rowId) : null;
        return row ? { ...w, title: row.title } : w;
      })
    );
    return { ...state, warnings };
  },
});
