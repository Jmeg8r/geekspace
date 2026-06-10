import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { makeId, type PropertyDef, type SelectOption } from "./lib/types";
import {
  calendarDateToLocalMs,
  localMsToCalendarDate,
  DAY_MS,
} from "./lib/scheduler";
import { DEFAULT_SETTINGS } from "./lib/defaults";
import { runReflow } from "./scheduling";

// WHAT: One-shot workspace seed — Notion Projects-style PM template (Projects +
// Tasks wired with a synced relation and a percent-complete rollup), a Welcome
// doc, and a believable week of events/tasks so the auto-scheduler has
// something to chew on immediately.

export const seedWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    if (existing?.seeded) return "already-seeded";
    if (existing) {
      await ctx.db.patch(existing._id, { seeded: true });
    } else {
      await ctx.db.insert("settings", { ...DEFAULT_SETTINGS, seeded: true });
    }

    const tz = existing?.tzOffsetMin ?? DEFAULT_SETTINGS.tzOffsetMin;
    const now = Date.now();
    const today = localMsToCalendarDate(now, tz);
    const day = (n: number) => today + n * DAY_MS;
    const at = (n: number, h: number, m = 0) =>
      calendarDateToLocalMs(day(n), tz, h * 60 + m);
    let order = now;
    const nextOrder = () => ++order;

    // ---------- Projects database ----------
    const pStatus: SelectOption[] = [
      { id: makeId(), name: "Not started", color: "gray", group: "todo" },
      { id: makeId(), name: "In progress", color: "blue", group: "inprogress" },
      { id: makeId(), name: "Shipped", color: "green", group: "complete" },
    ];
    const pStatusId = makeId();
    const pTargetId = makeId();
    const projectsProps: PropertyDef[] = [
      { id: "title", name: "Name", type: "title" },
      { id: pStatusId, name: "Status", type: "status", options: pStatus },
      { id: pTargetId, name: "Target date", type: "date" },
    ];
    const projectsDbId = await ctx.db.insert("databases", {
      name: "Projects",
      properties: projectsProps,
      color: "blue",
    });

    // ---------- Tasks database ----------
    const tStatus: SelectOption[] = [
      { id: makeId(), name: "Not started", color: "gray", group: "todo" },
      { id: makeId(), name: "In progress", color: "blue", group: "inprogress" },
      { id: makeId(), name: "Done", color: "green", group: "complete" },
    ];
    // WHY: priority option ORDER is the engine's priority scale (0=Urgent .. 3=Low).
    const tPriority: SelectOption[] = [
      { id: makeId(), name: "Urgent", color: "red" },
      { id: makeId(), name: "High", color: "orange" },
      { id: makeId(), name: "Medium", color: "yellow" },
      { id: makeId(), name: "Low", color: "gray" },
    ];
    const tStatusId = makeId();
    const tDueId = makeId();
    const tEstimateId = makeId();
    const tPriorityId = makeId();
    const tProjectId = makeId(); // relation Tasks -> Projects
    const pTasksId = makeId(); // synced reverse Projects -> Tasks
    const pProgressId = makeId(); // rollup on Projects

    const tasksProps: PropertyDef[] = [
      { id: "title", name: "Name", type: "title" },
      { id: tStatusId, name: "Status", type: "status", options: tStatus },
      { id: tPriorityId, name: "Priority", type: "select", options: tPriority },
      { id: tDueId, name: "Due", type: "date" },
      { id: tEstimateId, name: "Estimate (min)", type: "number", numberFormat: "minutes" },
      {
        id: tProjectId,
        name: "Project",
        type: "relation",
        relation: { databaseId: projectsDbId, syncedPropId: pTasksId },
      },
    ];
    const tasksDbId = await ctx.db.insert("databases", {
      name: "Tasks",
      properties: tasksProps,
      color: "orange",
      showOnCalendar: true,
      calendarDatePropId: tDueId,
      isTaskSource: true,
      taskConfig: {
        statusPropId: tStatusId,
        datePropId: tDueId,
        estimatePropId: tEstimateId,
        priorityPropId: tPriorityId,
      },
    });

    // Wire the reverse relation + progress rollup onto Projects.
    await ctx.db.patch(projectsDbId, {
      properties: [
        ...projectsProps,
        {
          id: pTasksId,
          name: "Tasks",
          type: "relation",
          relation: { databaseId: tasksDbId, syncedPropId: tProjectId },
        },
        {
          id: pProgressId,
          name: "Progress",
          type: "rollup",
          numberFormat: "progress",
          rollup: {
            relationPropId: pTasksId,
            targetPropId: tStatusId,
            aggregate: "percentComplete",
          },
        },
      ] satisfies PropertyDef[],
    });

    // ---------- Pages ----------
    const projectsPageId = await ctx.db.insert("pages", {
      title: "Projects",
      icon: "🗂️",
      kind: "database",
      databaseId: projectsDbId,
      favorite: true,
      trashed: false,
      order: nextOrder(),
      updatedAt: now,
    });
    await ctx.db.patch(projectsDbId, { pageId: projectsPageId });

    const tasksPageId = await ctx.db.insert("pages", {
      title: "Tasks",
      icon: "✅",
      kind: "database",
      databaseId: tasksDbId,
      favorite: true,
      trashed: false,
      order: nextOrder(),
      updatedAt: now,
    });
    await ctx.db.patch(tasksDbId, { pageId: tasksPageId });

    // ---------- Views ----------
    const doneOption = tStatus[2];
    await ctx.db.insert("views", { databaseId: projectsDbId, name: "Table", type: "table", order: 1 });
    await ctx.db.insert("views", { databaseId: projectsDbId, name: "Board", type: "board", groupByPropId: pStatusId, order: 2 });
    await ctx.db.insert("views", { databaseId: projectsDbId, name: "Timeline", type: "timeline", datePropId: pTargetId, order: 3 });
    await ctx.db.insert("views", { databaseId: tasksDbId, name: "Table", type: "table", order: 1 });
    await ctx.db.insert("views", { databaseId: tasksDbId, name: "Board", type: "board", groupByPropId: tStatusId, order: 2 });
    await ctx.db.insert("views", { databaseId: tasksDbId, name: "Calendar", type: "calendar", datePropId: tDueId, order: 3 });
    await ctx.db.insert("views", {
      databaseId: tasksDbId,
      name: "My Tasks",
      type: "list",
      filters: { conjunction: "and", rules: [{ propId: tStatusId, op: "isNot", value: doneOption.id }] },
      sorts: [{ propId: tDueId, dir: "asc" }],
      order: 4,
    });

    // ---------- Sample projects ----------
    async function insertRow(
      databaseId: Id<"databases">,
      title: string,
      properties: Record<string, unknown>
    ) {
      return ctx.db.insert("rows", {
        databaseId,
        title,
        properties: { title, ...properties },
        order: nextOrder(),
        updatedAt: now,
      });
    }

    const projGeek = await insertRow(projectsDbId, "Geekspace Launch", {
      [pStatusId]: pStatus[1].id,
      [pTargetId]: { start: day(10) },
    });
    const projArticle = await insertRow(projectsDbId, "ASTGL Article: Building My Own Notion", {
      [pStatusId]: pStatus[1].id,
      [pTargetId]: { start: day(5) },
    });
    const projLab = await insertRow(projectsDbId, "Home Lab Refresh", {
      [pStatusId]: pStatus[0].id,
      [pTargetId]: { start: day(20) },
    });

    // ---------- Sample tasks ----------
    type TaskSeed = [title: string, statusIdx: number, prioIdx: number, estimate: number, dueDay: number, project: Id<"rows">];
    const taskSeeds: TaskSeed[] = [
      ["Write Geekspace README", 1, 1, 90, 1, projGeek],
      ["Design app icon", 0, 2, 60, 2, projGeek],
      ["Record demo video", 0, 2, 120, 4, projGeek],
      ["Set up repo + branch protection", 2, 1, 30, -1, projGeek],
      ["Draft article outline", 1, 0, 60, 1, projArticle],
      ["Write first draft", 0, 1, 180, 3, projArticle],
      ["Edit + publish", 0, 1, 90, 5, projArticle],
      ["Inventory rack hardware", 0, 3, 45, 8, projLab],
      ["Plan Proxmox migration", 0, 2, 120, 12, projLab],
      ["Update DNS + reverse proxy", 0, 3, 60, 14, projLab],
    ];
    const tasksByProject = new Map<string, string[]>();
    for (const [title, statusIdx, prioIdx, estimate, dueDay, project] of taskSeeds) {
      const rowId = await insertRow(tasksDbId, title, {
        [tStatusId]: tStatus[statusIdx].id,
        [tPriorityId]: tPriority[prioIdx].id,
        [tEstimateId]: estimate,
        [tDueId]: { start: day(dueDay) },
        [tProjectId]: [project],
      });
      const list = tasksByProject.get(project) ?? [];
      list.push(rowId);
      tasksByProject.set(project, list);
    }
    // Keep the synced side consistent.
    for (const [projectId, taskIds] of tasksByProject) {
      const proj = await ctx.db.get(projectId as Id<"rows">);
      if (proj) {
        await ctx.db.patch(proj._id, {
          properties: { ...(proj.properties ?? {}), [pTasksId]: taskIds },
        });
      }
    }

    // ---------- Events this week ----------
    const eventSeeds: Array<[string, number, number, number, number, number, string]> = [
      // title, day, startH, startM, endH, endM, color
      ["Team standup", 1, 9, 30, 10, 0, "blue"],
      ["Lunch with Sarah", 1, 12, 0, 13, 0, "teal"],
      ["Doctor appointment", 2, 14, 0, 15, 0, "purple"],
      ["Podcast recording", 3, 13, 0, 14, 30, "pink"],
    ];
    for (const [title, d, sh, sm, eh, em, color] of eventSeeds) {
      await ctx.db.insert("events", {
        title,
        start: at(d, sh, sm),
        end: at(d, eh, em),
        color,
      });
    }

    // ---------- Welcome doc ----------
    const welcome = [
      { type: "heading", props: { level: 1 }, content: "Welcome to Geekspace 👋" },
      {
        type: "paragraph",
        content:
          "Your workspace, As The Geek Learns it — pages, databases, and a calendar that schedules itself.",
      },
      { type: "heading", props: { level: 2 }, content: "What you can do here" },
      { type: "bulletListItem", content: "Write docs with a Notion-style block editor — type / for the block menu." },
      { type: "bulletListItem", content: "Build databases with properties, then view them as tables, boards, calendars, and timelines." },
      { type: "bulletListItem", content: "Give tasks an estimate + due date and the calendar auto-blocks time around your appointments." },
      { type: "heading", props: { level: 2 }, content: "Try it now" },
      { type: "checkListItem", props: { checked: false }, content: "Press ⌘K and search for anything" },
      { type: "checkListItem", props: { checked: false }, content: "Open Calendar and drag a time block — it locks in place" },
      { type: "checkListItem", props: { checked: false }, content: "Mark a task Done and watch the schedule reflow" },
      {
        type: "quote",
        content: "If I do something more than twice, automate it.",
      },
    ];
    const welcomePageId = await ctx.db.insert("pages", {
      title: "Welcome to Geekspace",
      icon: "🚀",
      kind: "doc",
      content: JSON.stringify(welcome),
      favorite: false,
      trashed: false,
      order: now - 10, // sort first among roots
      updatedAt: now,
    });

    const ideas = [
      { type: "heading", props: { level: 2 }, content: "Content ideas" },
      { type: "bulletListItem", content: "I built my own Notion with Claude — here's what I learned" },
      { type: "bulletListItem", content: "Auto time-blocking: the algorithm behind Motion, explained" },
      { type: "bulletListItem", content: "Convex as a local-first personal database" },
    ];
    await ctx.db.insert("pages", {
      title: "Content Ideas",
      icon: "💡",
      kind: "doc",
      parentId: welcomePageId,
      content: JSON.stringify(ideas),
      favorite: false,
      trashed: false,
      order: nextOrder(),
      updatedAt: now,
    });

    await runReflow(ctx);
    return "seeded";
  },
});
