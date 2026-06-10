import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// WHAT: Geekspace data model — Notion-style pages/databases/rows/views plus
// calendar events and engine-managed time blocks.
// WHY: `properties` on databases/rows stays schemaless (v.any) because property
// definitions are user-defined at runtime; shape is enforced in convex/lib/types.ts.
export default defineSchema({
  pages: defineTable({
    title: v.string(),
    icon: v.optional(v.string()),
    kind: v.union(v.literal("doc"), v.literal("database")),
    parentId: v.optional(v.id("pages")),
    databaseId: v.optional(v.id("databases")),
    content: v.optional(v.string()), // BlockNote document JSON
    favorite: v.boolean(),
    trashed: v.boolean(),
    order: v.number(),
    updatedAt: v.number(),
  })
    .index("by_parent", ["parentId"])
    .searchIndex("search_title", { searchField: "title" }),

  databases: defineTable({
    name: v.string(),
    pageId: v.optional(v.id("pages")),
    properties: v.array(v.any()), // PropertyDef[]
    color: v.optional(v.string()),
    showOnCalendar: v.optional(v.boolean()),
    calendarDatePropId: v.optional(v.string()),
    isTaskSource: v.optional(v.boolean()),
    taskConfig: v.optional(
      v.object({
        statusPropId: v.string(),
        datePropId: v.string(),
        estimatePropId: v.string(),
        priorityPropId: v.string(),
      })
    ),
  }),

  rows: defineTable({
    databaseId: v.id("databases"),
    title: v.string(), // denormalized from the title property for search/display
    properties: v.any(), // Record<propId, value>
    content: v.optional(v.string()), // BlockNote JSON when opened as a page
    order: v.number(),
    updatedAt: v.number(),
  })
    .index("by_database", ["databaseId"])
    .searchIndex("search_title", { searchField: "title" }),

  views: defineTable({
    databaseId: v.id("databases"),
    name: v.string(),
    type: v.string(), // ViewType
    groupByPropId: v.optional(v.string()),
    datePropId: v.optional(v.string()),
    filters: v.optional(v.any()), // FilterConfig
    sorts: v.optional(v.any()), // SortRule[]
    hiddenPropIds: v.optional(v.array(v.string())),
    order: v.number(),
  }).index("by_database", ["databaseId"]),

  events: defineTable({
    title: v.string(),
    start: v.number(),
    end: v.number(),
    allDay: v.optional(v.boolean()),
    color: v.optional(v.string()),
    notes: v.optional(v.string()),
  }).index("by_start", ["start"]),

  timeBlocks: defineTable({
    taskRowId: v.id("rows"),
    databaseId: v.id("databases"),
    start: v.number(),
    end: v.number(),
    locked: v.boolean(),
    pastDue: v.optional(v.boolean()),
  })
    .index("by_start", ["start"])
    .index("by_task", ["taskRowId"]),

  settings: defineTable({
    key: v.string(), // singleton: "global"
    theme: v.string(), // "light" | "dark" | "system"
    workDays: v.array(v.number()),
    dayStartMin: v.number(),
    dayEndMin: v.number(),
    minChunkMin: v.number(),
    maxChunkMin: v.number(),
    bufferMin: v.number(),
    horizonDays: v.number(),
    granularityMin: v.number(),
    tzOffsetMin: v.optional(v.number()),
    seeded: v.optional(v.boolean()),
  }).index("by_key", ["key"]),

  schedulerState: defineTable({
    key: v.string(), // singleton: "global"
    warnings: v.any(), // SchedulerWarning[]
    lastRun: v.number(),
  }).index("by_key", ["key"]),
});
