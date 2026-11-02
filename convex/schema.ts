import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { proposal } from "./lib/assistantProposal";

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
    // Project tags: links this page to one or more rows in the Projects
    // database (the same database Tasks relate to). Shown as colored chips.
    projectRowIds: v.optional(v.array(v.id("rows"))),
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
  })
    .index("by_start", ["start"])
    // Busy time is every event still running, however long ago it began.
    .index("by_end", ["end"]),

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
    micDeviceId: v.optional(v.string()),
    micDeviceLabel: v.optional(v.string()),
    // Day Recorder (docs/changes/2026-10-18-day-recorder/). Read through
    // dayRecorder.getSettings, which supplies the defaults.
    dayRecorderEnabled: v.optional(v.boolean()),
    // Saved, not runtime-only, so a paused recorder stays paused across a relaunch or crash.
    dayRecorderPaused: v.optional(v.boolean()),
    dayRecorderDenylist: v.optional(v.array(v.string())), // app bundle ids
    dayRecorderShotSec: v.optional(v.number()),
    assistantBatchMin: v.optional(v.number()),
    assistantDailyCapUsd: v.optional(v.number()), // unset = the assistant does not run
    // Where the assistant's last batch ended (plan PR 6a): text after it is new.
    // Where the assistant starts reading: the local midnight of the day it first ran.
    assistantSince: v.optional(v.number()),
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
    generatedContent: v.optional(v.string()), // what the app last wrote to that page; a mismatch means you edited it
    eventId: v.optional(v.id("events")), // linked calendar event
  }).index("by_startedAt", ["startedAt"]),

  // ---- Day Recorder (docs/changes/2026-10-18-day-recorder/) ----
  // Raw media lives on disk under the media root; these tables hold the index and the text.
  // `path` is always "<day>/<file>", relative to the media root (convex/lib/dayRecorder.ts).

  captureSegments: defineTable({
    day: v.string(), // YYYY-MM-DD, local
    kind: v.union(v.literal("mic"), v.literal("system"), v.literal("call")),
    path: v.string(),
    start: v.number(),
    end: v.number(),
    status: v.union(v.literal("closed"), v.literal("transcribed"), v.literal("failed"), v.literal("purged")),
    noticeEventId: v.optional(v.id("recorderEvents")), // required for kind "call"
    purgedAt: v.optional(v.number()),
  })
    .index("by_day", ["day"])
    // Retention reads only unpurged rows: purgedAt undefined, oldest first.
    .index("by_purged_start", ["purgedAt", "start"])
    // Transcription reads closed segments, oldest first (plan PR 5).
    .index("by_status_start", ["status", "start"]),

  transcripts: defineTable({
    segmentId: v.id("captureSegments"),
    start: v.number(),
    end: v.number(),
    text: v.string(),
    // When the assistant read it: set in the same write that records the call's cost.
    readAt: v.optional(v.number()),
    // How much of a long text has been read so far, in characters (Codex review of PR 6a).
    readChars: v.optional(v.number()),
  })
    .index("by_segment", ["segmentId"])
    // What the assistant has not read yet, oldest first (plan PR 6a, Codex review round 1).
    .index("by_read_start", ["readAt", "start"])
    .searchIndex("search_text", { searchField: "text" }),

  screenshots: defineTable({
    day: v.string(),
    path: v.string(),
    takenAt: v.number(),
    // Absent when unknown: the helper names no app while a denylisted one owned the menu bar
    // or the owner changed during the capture (protocol.md).
    appBundleId: v.optional(v.string()),
    ocrText: v.string(),
    purgedAt: v.optional(v.number()), // image deleted; the OCR text is kept
    // When the assistant read its text (plan PR 6a); purged images' text is read too.
    readAt: v.optional(v.number()),
    readChars: v.optional(v.number()),
  })
    .index("by_purged_takenAt", ["purgedAt", "takenAt"])
    .index("by_read_takenAt", ["readAt", "takenAt"])
    .searchIndex("search_ocr", { searchField: "ocrText" }),

  recorderEvents: defineTable({
    at: v.number(),
    kind: v.union(
      v.literal("noticeGiven"),
      v.literal("noticeDeclined"),
      v.literal("imageSent"),
      v.literal("capError"),
      v.literal("purged"),
      v.literal("capPaused")
    ),
    detail: v.optional(v.string()),
    count: v.optional(v.number()),
    screenshotId: v.optional(v.id("screenshots")),
  }).index("by_at", ["at"]),

  // One row per effect the assistant had inside Geekspace. Effects of one proposal share a
  // groupId (the id of the row or draft at its root), and undo reverses the whole group.
  // WHY a union, not before/after blobs: v1 actions only create, so undo needs exactly what
  // was created plus what it looked like then, and a typed shape keeps that checkable.
  assistantActions: defineTable(
    v.union(
      v.object({
        kind: v.literal("createTask"),
        at: v.number(),
        groupId: v.string(),
        rowId: v.id("rows"),
        // The row as created (title, properties, content). WHY not updatedAt: two writes in
        // the same millisecond would look unchanged. See rowFingerprint().
        rowFingerprint: v.string(),
        sourceSegmentId: v.optional(v.id("captureSegments")),
        sourceScreenshotId: v.optional(v.id("screenshots")),
        undoneAt: v.optional(v.number()),
      }),
      v.object({
        kind: v.literal("createBlock"),
        at: v.number(),
        groupId: v.string(),
        blockId: v.id("timeBlocks"),
        taskRowId: v.id("rows"),
        start: v.number(),
        end: v.number(),
        sourceSegmentId: v.optional(v.id("captureSegments")),
        sourceScreenshotId: v.optional(v.id("screenshots")),
        undoneAt: v.optional(v.number()),
      }),
      v.object({
        kind: v.literal("draftLinear"),
        at: v.number(),
        groupId: v.string(),
        draftId: v.id("externalDrafts"),
        sourceSegmentId: v.optional(v.id("captureSegments")),
        sourceScreenshotId: v.optional(v.id("screenshots")),
        undoneAt: v.optional(v.number()),
      })
    )
  )
    .index("by_at", ["at"])
    .index("by_group", ["groupId"]),

  // Anything that would leave Geekspace. Nothing is sent until James approves it.
  externalDrafts: defineTable({
    target: v.literal("linear"),
    issueRef: v.string(),
    body: v.string(),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("sent"), v.literal("discarded")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_status", ["status"]),

  // One call to Claude (plan PR 6a, Codex review round 1). Made only after its worst case is
  // reserved against the day's cap; settled with its real cost, the items it read and its
  // proposals in one write; its proposals applied one by one, each once.
  assistantRequests: defineTable({
    day: v.string(),
    at: v.number(),
    status: v.union(v.literal("inFlight"), v.literal("settled"), v.literal("done")),
    reservedUsd: v.number(),
    transcriptIds: v.array(v.id("transcripts")),
    screenshotIds: v.array(v.id("screenshots")),
    // The call's own usage once settled (spec R8: every call logged with tokens and cost).
    costUsd: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    // Cached input, written and read; absent on calls settled before they were kept.
    cacheWriteTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    // Where each item's part ends, in characters; absent: the whole item.
    transcriptEnds: v.optional(v.array(v.number())),
    screenshotEnds: v.optional(v.array(v.number())),
    proposals: v.optional(
      v.array(
        v.object({
          proposal,
          state: v.union(v.literal("pending"), v.literal("applied"), v.literal("refused")),
        })
      )
    ),
  })
    .index("by_status", ["status"])
    .index("by_day_status", ["day", "status"]),

  assistantUsage: defineTable({
    day: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheWriteTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    costUsd: v.number(),
  }).index("by_day", ["day"]),
});
