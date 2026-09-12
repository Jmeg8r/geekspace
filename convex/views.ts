import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import type { Doc } from "./_generated/dataModel";
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
    type: v.union(
      v.literal("table"),
      v.literal("board"),
      v.literal("list"),
      v.literal("calendar"),
      v.literal("timeline"),
    ),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return null;
    const props = db.properties as PropertyDef[];
    const defaultNames = {
      table: "Table",
      board: "Board",
      list: "List",
      calendar: "Calendar",
      timeline: "Timeline",
    } satisfies Record<string, string>;
    // SAFETY: `args.type` is unvalidated client input and may not be a
    // recognized view type. Object.hasOwn guards the lookup so a key like
    // "toString" or "constructor" can't resolve through the prototype chain
    // to an inherited function instead of falling back to "View".
    const defaultName = Object.hasOwn(defaultNames, args.type)
      ? defaultNames[args.type as keyof typeof defaultNames]
      : "View";
    const doc: WithoutSystemFields<Doc<"views">> = {
      databaseId: args.databaseId,
      name: args.name ?? defaultName,
      type: args.type,
      order: Date.now(),
    };
    // Sensible defaults so new views render immediately.
    if (args.type === "board") {
      const groupProp =
        props.find((p) => p.type === "status") ??
        props.find((p) => p.type === "select");
      if (groupProp) doc.groupByPropId = groupProp.id;
    }
    if (args.type === "calendar" || args.type === "timeline") {
      const dateProp = props.find((p) => p.type === "date");
      if (dateProp) doc.datePropId = dateProp.id;
    }
    return ctx.db.insert("views", doc);
  },
});

export const update = mutation({
  args: {
    viewId: v.id("views"),
    name: v.optional(v.string()),
    groupByPropId: v.optional(v.string()),
    datePropId: v.optional(v.string()),
    filters: v.optional(
      v.object({
        conjunction: v.union(v.literal("and"), v.literal("or")),
        rules: v.array(
          v.object({
            propId: v.string(),
            op: v.union(
              v.literal("contains"),
              v.literal("notContains"),
              v.literal("is"),
              v.literal("isNot"),
              v.literal("isEmpty"),
              v.literal("isNotEmpty"),
              v.literal("eq"),
              v.literal("neq"),
              v.literal("gt"),
              v.literal("lt"),
              v.literal("before"),
              v.literal("after"),
              v.literal("checked"),
              v.literal("unchecked"),
            ),
            value: v.optional(v.union(v.string(), v.number())),
          }),
        ),
      }),
    ),
    sorts: v.optional(
      v.array(
        v.object({
          propId: v.string(),
          dir: v.union(v.literal("asc"), v.literal("desc")),
        }),
      ),
    ),
    hiddenPropIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const { viewId, ...rest } = args;
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, val]) => val !== undefined),
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
