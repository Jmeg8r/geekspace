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
    const existing = await ctx.db.get(eventId);
    if (!existing) return;
    // External mirrors are read-only here — edit them in macOS Calendar.
    if (existing.source) throw new Error("Synced event — edit it in macOS Calendar.");
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
    const existing = await ctx.db.get(args.eventId);
    if (!existing) return;
    if (existing.source) throw new Error("Synced event — delete it in macOS Calendar.");
    await ctx.db.delete(args.eventId);
    await runReflow(ctx, args.tzOffsetMin);
  },
});

const SYNC_COLORS = ["teal", "blue", "purple", "pink", "green", "yellow", "brown", "red"];
function calendarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SYNC_COLORS[h % SYNC_COLORS.length];
}

/**
 * Upsert the mirror of macOS Calendar inside a time window: insert new events,
 * patch changed ones, delete mirrors that vanished, then reflow — synced
 * appointments are fixed busy time the auto-scheduler must plan around.
 */
export const syncExternal = mutation({
  args: {
    windowStart: v.number(),
    windowEnd: v.number(),
    items: v.array(
      v.object({
        externalId: v.string(),
        title: v.string(),
        start: v.number(),
        end: v.number(),
        allDay: v.optional(v.boolean()),
        calendarName: v.optional(v.string()),
      })
    ),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = (
      await ctx.db
        .query("events")
        .withIndex("by_start", (q) => q.gte("start", args.windowStart - 35 * DAY_MS))
        .collect()
    ).filter(
      (e) => e.source === "macos" && e.start < args.windowEnd && e.end > args.windowStart
    );
    const byExternalId = new Map(existing.map((e) => [e.externalId, e]));
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    let removed = 0;

    for (const item of args.items) {
      if (seen.has(item.externalId)) continue; // recurring events can repeat uids
      seen.add(item.externalId);
      const cur = byExternalId.get(item.externalId);
      if (!cur) {
        await ctx.db.insert("events", {
          ...item,
          source: "macos",
          color: calendarColor(item.calendarName ?? ""),
        });
        created++;
      } else if (
        cur.title !== item.title ||
        cur.start !== item.start ||
        cur.end !== item.end ||
        (cur.allDay ?? false) !== (item.allDay ?? false) ||
        cur.calendarName !== item.calendarName
      ) {
        await ctx.db.patch(cur._id, { ...item });
        updated++;
      }
    }
    for (const e of existing) {
      if (e.externalId && !seen.has(e.externalId)) {
        await ctx.db.delete(e._id);
        removed++;
      }
    }

    if (created || updated || removed) await runReflow(ctx, args.tzOffsetMin);
    return { created, updated, removed, total: seen.size };
  },
});
