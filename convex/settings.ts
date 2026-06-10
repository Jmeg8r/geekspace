import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { DEFAULT_SETTINGS } from "./lib/defaults";
import { getMergedSettings, runReflow } from "./scheduling";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const { merged } = await getMergedSettings(ctx);
    return merged;
  },
});

export const update = mutation({
  args: {
    theme: v.optional(v.string()),
    workDays: v.optional(v.array(v.number())),
    dayStartMin: v.optional(v.number()),
    dayEndMin: v.optional(v.number()),
    minChunkMin: v.optional(v.number()),
    maxChunkMin: v.optional(v.number()),
    bufferMin: v.optional(v.number()),
    horizonDays: v.optional(v.number()),
    granularityMin: v.optional(v.number()),
    tzOffsetMin: v.optional(v.number()),
    macCalendarSync: v.optional(v.boolean()),
    macCalendarNames: v.optional(v.array(v.string())),
    mailWidget: v.optional(v.boolean()),
    ollamaUrl: v.optional(v.string()),
    ollamaModel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch = Object.fromEntries(
      Object.entries(args).filter(([, val]) => val !== undefined)
    );
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("settings", { ...DEFAULT_SETTINGS, ...patch });
    }
    // WHY: working hours / chunk sizes change the plan — recompute immediately.
    await runReflow(ctx, args.tzOffsetMin);
  },
});
