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

// Every type a user may add; "title" is created with the database and never added.
const addablePropertyType = v.union(
  v.literal("text"),
  v.literal("number"),
  v.literal("select"),
  v.literal("multiSelect"),
  v.literal("status"),
  v.literal("date"),
  v.literal("checkbox"),
  v.literal("url"),
  v.literal("relation"),
  v.literal("rollup"),
  v.literal("createdTime"),
  v.literal("updatedTime")
);

const selectOption = v.object({
  id: v.string(),
  name: v.string(),
  color: v.string(),
  group: v.optional(v.union(v.literal("todo"), v.literal("inprogress"), v.literal("complete"))),
});

const numberFormat = v.union(
  v.literal("plain"),
  v.literal("minutes"),
  v.literal("percent"),
  v.literal("dollar"),
  v.literal("progress")
);

const rollupConfig = v.object({
  relationPropId: v.string(),
  targetPropId: v.string(),
  aggregate: v.union(
    v.literal("count"),
    v.literal("countValues"),
    v.literal("sum"),
    v.literal("average"),
    v.literal("min"),
    v.literal("max"),
    v.literal("percentComplete")
  ),
});

export const addProperty = mutation({
  args: {
    databaseId: v.id("databases"),
    type: addablePropertyType,
    name: v.optional(v.string()),
    targetDatabaseId: v.optional(v.id("databases")), // for relation
  },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return null;
    if (args.type === "relation" && !args.targetDatabaseId) {
      throw new Error("A relation property needs the database it links to");
    }
    const props = db.properties as PropertyDef[];
    const propId = makeId();
    const def: PropertyDef = {
      id: propId,
      name: args.name ?? defaultPropName(args.type, props),
      type: args.type,
    };
    if (args.type === "select" || args.type === "multiSelect") def.options = [];
    if (args.type === "status") def.options = defaultStatusOptions();
    if (args.type === "number") def.numberFormat = "plain";
    if (args.type === "relation" && args.targetDatabaseId) {
      const target = await ctx.db.get(args.targetDatabaseId);
      if (!target) return null;
      const reverseId = makeId();
      def.relation = { databaseId: args.targetDatabaseId, syncedPropId: reverseId };
      const reverse: PropertyDef = {
        id: reverseId,
        // WHY: same-database pairs (sub-tasks, dependencies) get a generic
        // reverse name the user renames; cross-db reverses are named after
        // the source database, like Notion.
        name:
          args.targetDatabaseId === args.databaseId
            ? `${def.name} (reverse)`
            : db.name || "Related",
        type: "relation",
        relation: { databaseId: args.databaseId, syncedPropId: propId },
      };
      if (args.targetDatabaseId === args.databaseId) {
        // Self-relation pair lives on the same properties array.
        await ctx.db.patch(args.databaseId, { properties: [...props, def, reverse] });
        return propId;
      }
      await ctx.db.patch(args.targetDatabaseId, {
        properties: [...(target.properties as PropertyDef[]), reverse],
      });
    }
    if (args.type === "rollup") {
      def.rollup = { relationPropId: "", targetPropId: "", aggregate: "count" };
    }
    await ctx.db.patch(args.databaseId, { properties: [...props, def] });
    return propId;
  },
});

function defaultPropName(type: string, existing: PropertyDef[]): string {
  const base = {
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
  } satisfies Record<string, string>;
  // SAFETY: `type` is unvalidated client input and may not be a recognized
  // property type. Object.hasOwn guards the lookup so a key like "toString"
  // or "constructor" can't resolve through the prototype chain to an
  // inherited function instead of falling back to "Property".
  const name = Object.hasOwn(base, type) ? base[type as keyof typeof base] : "Property";
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
    options: v.optional(v.array(selectOption)),
    numberFormat: v.optional(numberFormat),
    rollup: v.optional(rollupConfig),
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
        next.numberFormat = args.numberFormat;
      if (args.rollup !== undefined) next.rollup = args.rollup;
      if (args.includeTime !== undefined) next.includeTime = args.includeTime;
      return next;
    });
    await ctx.db.patch(args.databaseId, { properties: props });
  },
});

export const removeProperty = mutation({
  args: { databaseId: v.id("databases"), propId: v.string(), tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return;
    const props = db.properties as PropertyDef[];
    const def = props.find((p) => p.id === args.propId);
    if (!def || def.type === "title") return; // title is permanent
    // Which property ids go, per database: this one, plus its synced reverse wherever it
    // lives, including the same database (Blocked by ⇄ Blocking, Parent task ⇄ Sub-tasks).
    const removals = new Map<string, Set<string>>([[db._id, new Set([def.id])]]);
    if (def.relation?.syncedPropId) {
      const there = removals.get(def.relation.databaseId) ?? new Set<string>();
      there.add(def.relation.syncedPropId);
      removals.set(def.relation.databaseId, there);
    }
    let touchedTaskSource = false;
    for (const [rawId, propIds] of removals) {
      const id = ctx.db.normalizeId("databases", rawId);
      const target = id ? await ctx.db.get(id) : null;
      if (!target) continue;
      if (target.isTaskSource) touchedTaskSource = true;
      const targetProps: PropertyDef[] = target.properties;
      await ctx.db.patch(target._id, {
        properties: targetProps.filter((p) => !propIds.has(p.id)),
      });
      // Clear stored values so stale data doesn't linger.
      const rows = await ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", target._id))
        .collect();
      for (const row of rows) {
        const values = { ...row.properties };
        const had = [...propIds].filter((p) => p in values);
        if (had.length === 0) continue;
        for (const p of had) delete values[p];
        await ctx.db.patch(row._id, { properties: values });
      }
    }
    // A removed dependency or estimate changes what the scheduler may place.
    if (touchedTaskSource) await runReflow(ctx, args.tzOffsetMin);
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
        blockedByPropId: v.optional(v.string()),
        sprintPropId: v.optional(v.string()),
        parentPropId: v.optional(v.string()),
      })
    ),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return;
    // WHY merge: the UI turns task source off with no config and back on with only the
    // four fields it can auto-detect. Replacing the stored mapping dropped the dependency,
    // parent and sprint wiring, and dependencies silently stopped shaping the schedule.
    // Turning it off keeps the mapping; turning it on keeps any field not re-supplied.
    const taskConfig =
      args.taskConfig === undefined
        ? db.taskConfig
        : {
            blockedByPropId: db.taskConfig?.blockedByPropId,
            sprintPropId: db.taskConfig?.sprintPropId,
            parentPropId: db.taskConfig?.parentPropId,
            ...args.taskConfig,
          };
    await ctx.db.patch(args.databaseId, { isTaskSource: args.isTaskSource, taskConfig });
    await runReflow(ctx, args.tzOffsetMin);
  },
});
