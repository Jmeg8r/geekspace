import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { PropertyDef } from "./lib/types";

export const list = query({
  args: { databaseId: v.id("databases") },
  handler: async (ctx, args) => {
    const views = await ctx.db
      .query("views")
      .withIndex("by_database", (q) => q.eq("databaseId", args.databaseId))
      .collect();
    views.sort((a, b) => a.order - b.order);
    return views;
  },
});

export const create = mutation({
  args: {
    databaseId: v.id("databases"),
    type: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return null;
    const props = db.properties as PropertyDef[];
    const defaultNames: Record<string, string> = {
      table: "Table",
      board: "Board",
      list: "List",
      calendar: "Calendar",
      timeline: "Timeline",
    };
    const doc: Record<string, unknown> = {
      databaseId: args.databaseId,
      name: args.name ?? defaultNames[args.type] ?? "View",
      type: args.type,
      order: Date.now(),
    };
    // Sensible defaults so new views render immediately.
    if (args.type === "board") {
      const groupProp =
        props.find((p) => p.type === "status") ?? props.find((p) => p.type === "select");
      if (groupProp) doc.groupByPropId = groupProp.id;
    }
    if (args.type === "calendar" || args.type === "timeline") {
      const dateProp = props.find((p) => p.type === "date");
      if (dateProp) doc.datePropId = dateProp.id;
    }
    return ctx.db.insert("views", doc as never);
  },
});

export const update = mutation({
  args: {
    viewId: v.id("views"),
    name: v.optional(v.string()),
    groupByPropId: v.optional(v.string()),
    datePropId: v.optional(v.string()),
    filters: v.optional(v.any()),
    sorts: v.optional(v.any()),
    hiddenPropIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { viewId, ...rest } = args;
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, val]) => val !== undefined)
    );
    await ctx.db.patch(viewId, patch);
  },
});

export const remove = mutation({
  args: { viewId: v.id("views") },
  handler: async (ctx, args) => {
    const view = await ctx.db.get(args.viewId);
    if (!view) return;
    const siblings = await ctx.db
      .query("views")
      .withIndex("by_database", (q) => q.eq("databaseId", view.databaseId))
      .collect();
    // WHY: a database must always keep at least one view.
    if (siblings.length <= 1) return;
    await ctx.db.delete(args.viewId);
  },
});
