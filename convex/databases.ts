import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { makeId, type PropertyDef, type SelectOption } from "./lib/types";
import { runReflow } from "./scheduling";

export const get = query({
  args: { databaseId: v.id("databases") },
  handler: async (ctx, args) => ctx.db.get(args.databaseId),
});

export const listAll = query({
  args: {},
  handler: async (ctx) => ctx.db.query("databases").collect(),
});

function defaultStatusOptions(): SelectOption[] {
  return [
    { id: makeId(), name: "Not started", color: "gray", group: "todo" },
    { id: makeId(), name: "In progress", color: "blue", group: "inprogress" },
    { id: makeId(), name: "Done", color: "green", group: "complete" },
  ];
}

export const addProperty = mutation({
  args: {
    databaseId: v.id("databases"),
    type: v.string(),
    name: v.optional(v.string()),
    targetDatabaseId: v.optional(v.id("databases")), // for relation
  },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return null;
    const props = db.properties as PropertyDef[];
    const propId = makeId();
    const def: PropertyDef = {
      id: propId,
      name: args.name ?? defaultPropName(args.type, props),
      type: args.type as PropertyDef["type"],
    };
    if (args.type === "select" || args.type === "multiSelect") def.options = [];
    if (args.type === "status") def.options = defaultStatusOptions();
    if (args.type === "number") def.numberFormat = "plain";
    if (args.type === "relation" && args.targetDatabaseId) {
      const target = await ctx.db.get(args.targetDatabaseId);
      if (!target) return null;
      if (args.targetDatabaseId === args.databaseId) {
        // Self-relations stay one-way to avoid sync loops.
        def.relation = { databaseId: args.targetDatabaseId };
      } else {
        const reverseId = makeId();
        def.relation = { databaseId: args.targetDatabaseId, syncedPropId: reverseId };
        const reverse: PropertyDef = {
          id: reverseId,
          name: db.name || "Related",
          type: "relation",
          relation: { databaseId: args.databaseId, syncedPropId: propId },
        };
        await ctx.db.patch(args.targetDatabaseId, {
          properties: [...(target.properties as PropertyDef[]), reverse],
        });
      }
    }
    if (args.type === "rollup") {
      def.rollup = { relationPropId: "", targetPropId: "", aggregate: "count" };
    }
    await ctx.db.patch(args.databaseId, { properties: [...props, def] });
    return propId;
  },
});

function defaultPropName(type: string, existing: PropertyDef[]): string {
  const base: Record<string, string> = {
    text: "Text",
    number: "Number",
    select: "Select",
    multiSelect: "Tags",
    status: "Status",
    date: "Date",
    checkbox: "Checkbox",
    url: "URL",
    relation: "Relation",
    rollup: "Rollup",
    createdTime: "Created",
    updatedTime: "Updated",
  };
  const name = base[type] ?? "Property";
  let candidate = name;
  let n = 1;
  while (existing.some((p) => p.name === candidate)) candidate = `${name} ${++n}`;
  return candidate;
}

export const updateProperty = mutation({
  args: {
    databaseId: v.id("databases"),
    propId: v.string(),
    name: v.optional(v.string()),
    options: v.optional(v.any()),
    numberFormat: v.optional(v.string()),
    rollup: v.optional(v.any()),
    includeTime: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return;
    const props = (db.properties as PropertyDef[]).map((p) => {
      if (p.id !== args.propId) return p;
      const next = { ...p };
      if (args.name !== undefined) next.name = args.name;
      if (args.options !== undefined) next.options = args.options;
      if (args.numberFormat !== undefined)
        next.numberFormat = args.numberFormat as PropertyDef["numberFormat"];
      if (args.rollup !== undefined) next.rollup = args.rollup;
      if (args.includeTime !== undefined) next.includeTime = args.includeTime;
      return next;
    });
    await ctx.db.patch(args.databaseId, { properties: props });
  },
});

export const removeProperty = mutation({
  args: { databaseId: v.id("databases"), propId: v.string() },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return;
    const props = db.properties as PropertyDef[];
    const def = props.find((p) => p.id === args.propId);
    if (!def || def.type === "title") return; // title is permanent
    await ctx.db.patch(args.databaseId, {
      properties: props.filter((p) => p.id !== args.propId),
    });
    // Clear stored values so stale data doesn't linger.
    const rows = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", args.databaseId))
      .collect();
    for (const row of rows) {
      const p = { ...(row.properties ?? {}) };
      if (args.propId in p) {
        delete p[args.propId];
        await ctx.db.patch(row._id, { properties: p });
      }
    }
    // Remove the synced reverse property too.
    if (def.relation?.syncedPropId && def.relation.databaseId !== args.databaseId) {
      const target = await ctx.db.get(def.relation.databaseId as typeof args.databaseId);
      if (target) {
        await ctx.db.patch(target._id, {
          properties: (target.properties as PropertyDef[]).filter(
            (p) => p.id !== def.relation!.syncedPropId
          ),
        });
      }
    }
  },
});

export const setCalendarConfig = mutation({
  args: {
    databaseId: v.id("databases"),
    showOnCalendar: v.optional(v.boolean()),
    color: v.optional(v.string()),
    calendarDatePropId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { databaseId, ...patch } = args;
    await ctx.db.patch(databaseId, patch);
  },
});

export const setTaskSource = mutation({
  args: {
    databaseId: v.id("databases"),
    isTaskSource: v.boolean(),
    taskConfig: v.optional(
      v.object({
        statusPropId: v.string(),
        datePropId: v.string(),
        estimatePropId: v.string(),
        priorityPropId: v.string(),
      })
    ),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.databaseId, {
      isTaskSource: args.isTaskSource,
      taskConfig: args.taskConfig,
    });
    await runReflow(ctx, args.tzOffsetMin);
  },
});
