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
        blockedByPropId: v.optional(v.string()),
        sprintPropId: v.optional(v.string()),
        parentPropId: v.optional(v.string()),
      })
    ),
    // Marks a database as the sprint container for `completeSprint` automation.
    sprintConfig: v.optional(
      v.object({
        statusPropId: v.string(), // select: Upcoming / Current / Completed
        datePropId: v.string(), // date range of the sprint
        tasksPropId: v.string(), // relation to the tasks database
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
    // External calendar sync (macOS Calendar): read-only mirrors, keyed by uid.
    source: v.optional(v.string()), // "macos"
    externalId: v.optional(v.string()),
    calendarName: v.optional(v.string()),
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
    pmUpgraded: v.optional(v.boolean()),
    macCalendarSync: v.optional(v.boolean()),
    macCalendarNames: v.optional(v.array(v.string())),
    mailWidget: v.optional(v.boolean()),
    ollamaUrl: v.optional(v.string()),
    ollamaModel: v.optional(v.string()),
  }).index("by_key", ["key"]),

  schedulerState: defineTable({
    key: v.string(), // singleton: "global"
    warnings: v.any(), // SchedulerWarning[]
    lastRun: v.number(),
  }).index("by_key", ["key"]),

  // Docs library: uploaded files with previews, optionally linked to a project.
  docs: defineTable({
    name: v.string(),
    storageId: v.id("_storage"),
    mime: v.string(),
    size: v.number(),
    tags: v.optional(v.array(v.string())),
    projectRowId: v.optional(v.id("rows")),
    trashed: v.optional(v.boolean()),
  })
    .index("by_project", ["projectRowId"])
    .searchIndex("search_name", { searchField: "name" }),

  // Project templates: reusable project structures with relative day offsets.
  templates: defineTable({
    name: v.string(),
    description: v.optional(v.string()),
    icon: v.optional(v.string()),
    category: v.optional(v.string()),
    payload: v.any(), // TemplatePayload (convex/lib/types.ts)
    seeded: v.optional(v.boolean()),
    trashed: v.optional(v.boolean()),
  }).index("by_name", ["name"]),

  // AI Meeting Notes: recording → whisper transcription → local-LLM summary.
  meetings: defineTable({
    title: v.string(),
    meetingType: v.optional(v.string()), // general | standup | one_on_one | client | interview | brainstorm
    status: v.string(), // recording | uploading | transcribing | summarizing | done | error
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    durationSec: v.optional(v.number()),
    audioStorageId: v.optional(v.id("_storage")),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    keyPoints: v.optional(v.array(v.string())),
    decisions: v.optional(v.array(v.string())),
    actionItems: v.optional(v.array(v.string())),
    modelUsed: v.optional(v.string()),
    error: v.optional(v.string()),
    progress: v.optional(v.number()), // 0-100 while transcribing
    pageId: v.optional(v.id("pages")), // generated notes page
    eventId: v.optional(v.id("events")), // linked calendar event
  }).index("by_startedAt", ["startedAt"]),
});
