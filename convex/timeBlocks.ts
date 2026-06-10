import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { PropertyDef } from "./lib/types";
import { runReflow } from "./scheduling";
import { DAY_MS } from "./lib/scheduler";

// WHAT: Engine-managed time blocks. Users can drag (which locks) or lock/unlock;
// everything else is the scheduler's job.

export const listRange = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    const blocks = await ctx.db
      .query("timeBlocks")
      .withIndex("by_start", (q) => q.gte("start", args.start - 2 * DAY_MS))
      .collect();
    const visible = blocks.filter((b) => b.start < args.end && b.end > args.start);

    const out = [];
    for (const b of visible) {
      const task = await ctx.db.get(b.taskRowId);
      if (!task) continue;
      const db = await ctx.db.get(b.databaseId);
      let done = false;
      if (db?.taskConfig) {
        const statusProp = (db.properties as PropertyDef[]).find(
          (p) => p.id === db.taskConfig!.statusPropId
        );
        const statusVal = task.properties?.[db.taskConfig.statusPropId];
        done =
          statusProp?.options?.find((o) => o.id === statusVal)?.group === "complete";
      }
      out.push({
        ...b,
        taskTitle: task.title || "Untitled task",
        color: db?.color ?? "orange",
        done,
      });
    }
    return out;
  },
});

export const move = mutation({
  args: {
    blockId: v.id("timeBlocks"),
    start: v.number(),
    end: v.number(),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // WHY: a manual drag means "I want it HERE" — the block locks so the engine
    // schedules around it (Motion/Reclaim behavior).
    await ctx.db.patch(args.blockId, {
      start: args.start,
      end: args.end,
      locked: true,
      pastDue: false,
    });
    await runReflow(ctx, args.tzOffsetMin);
  },
});

export const toggleLock = mutation({
  args: { blockId: v.id("timeBlocks"), tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const block = await ctx.db.get(args.blockId);
    if (!block) return;
    await ctx.db.patch(args.blockId, { locked: !block.locked });
    // Unlocking hands the block back to the engine; locking pins current time.
    await runReflow(ctx, args.tzOffsetMin);
  },
});
