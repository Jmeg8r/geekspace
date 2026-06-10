import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { runReflow } from "./scheduling";
import { DAY_MS } from "./lib/scheduler";

// WHAT: Standalone calendar events (appointments). Any change reflows the
// auto-schedule because fixed events shape the free time everything else
// fits into.

export const listRange = query({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, args) => {
    // Pull a little earlier than `start` to catch multi-day events that overlap.
    const events = await ctx.db
      .query("events")
      .withIndex("by_start", (q) => q.gte("start", args.start - 35 * DAY_MS))
      .collect();
    return events.filter((e) => e.start < args.end && e.end > args.start);
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    start: v.number(),
    end: v.number(),
    allDay: v.optional(v.boolean()),
    color: v.optional(v.string()),
    notes: v.optional(v.string()),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tzOffsetMin, ...doc } = args;
    const id = await ctx.db.insert("events", doc);
    await runReflow(ctx, tzOffsetMin);
    return id;
  },
});

export const update = mutation({
  args: {
    eventId: v.id("events"),
    title: v.optional(v.string()),
    start: v.optional(v.number()),
    end: v.optional(v.number()),
    allDay: v.optional(v.boolean()),
    color: v.optional(v.string()),
    notes: v.optional(v.string()),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { eventId, tzOffsetMin, ...rest } = args;
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, val]) => val !== undefined)
    );
    await ctx.db.patch(eventId, patch);
    await runReflow(ctx, tzOffsetMin);
  },
});

export const remove = mutation({
  args: { eventId: v.id("events"), tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.eventId);
    await runReflow(ctx, args.tzOffsetMin);
  },
});
