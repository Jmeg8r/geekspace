import { mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { makeId, type PropertyDef, type SelectOption } from "./lib/types";
import { localMsToCalendarDate, DAY_MS } from "./lib/scheduler";
import { getMergedSettings, runReflow } from "./scheduling";
import { DEFAULT_SETTINGS } from "./lib/defaults";

// WHAT: Notion Projects parity — sub-tasks, dependencies, sprints — delivered
// as an idempotent upgrade that can run on a live workspace, plus the
// "Complete sprint" automation.

const SPRINT_LENGTH_DAYS = 14;

// Compact in-app guide — the full version lives in docs/USER-GUIDE.md.
const USER_GUIDE_BLOCKS = [
  { type: "heading", props: { level: 1 }, content: "Geekspace User Guide 📖" },
  { type: "paragraph", content: "The essentials. Full guide: docs/USER-GUIDE.md in the repo." },
  { type: "heading", props: { level: 2 }, content: "Pages & writing" },
  { type: "bulletListItem", content: "Type / in any page for the block menu — headings, lists, to-dos, tables, images, code." },
  { type: "bulletListItem", content: "Markdown shortcuts work: # heading, - list, [] to-do, > quote." },
  { type: "bulletListItem", content: "Hover a page in the sidebar for ⋯ (favorite/trash) and + (add a page inside)." },
  { type: "heading", props: { level: 2 }, content: "Databases & projects" },
  { type: "bulletListItem", content: "Every row opens as a full page (hover → Open, or click a board card)." },
  { type: "bulletListItem", content: "Views are lenses: Table, Board, List, Calendar, Timeline — each with its own filters and sorts." },
  { type: "bulletListItem", content: "Projects ⇄ Tasks are linked; Progress on a project is the % of its tasks done." },
  { type: "bulletListItem", content: "Sub-tasks: set a Parent task. Dependencies: set Blocked by — blocked work is auto-scheduled after its blockers." },
  { type: "bulletListItem", content: "Sprints: tasks carry a Sprint; the Sprint Board shows the current one. Complete sprint closes it and rolls open tasks forward." },
  { type: "heading", props: { level: 2 }, content: "The self-scheduling calendar" },
  { type: "bulletListItem", content: "A task needs an estimate + due date to get time blocks. Solid = appointments, translucent ⚡ = auto-scheduled, lock = pinned." },
  { type: "bulletListItem", content: "Drag a block to pin it; right-click to lock/unlock, mark done, or open the task." },
  { type: "bulletListItem", content: "Everything reflows automatically when events, tasks, or settings change. Red stripes = past due; check the needs-attention badge." },
  { type: "bulletListItem", content: "Keys: T today · J/K next/prev · W/M week/month view." },
  { type: "heading", props: { level: 2 }, content: "macOS Calendar & Mail" },
  { type: "bulletListItem", content: "Settings → macOS integrations. First sync asks for Automation permission — click OK." },
  { type: "bulletListItem", content: "Synced events are read-only (dotted edge) and the scheduler plans around them. Edit them in Calendar." },
  { type: "bulletListItem", content: "The Home inbox reads Mail.app: open a message in Mail, or + to turn it into a task with a link back." },
  { type: "heading", props: { level: 2 }, content: "Shortcuts" },
  { type: "bulletListItem", content: "⌘K search · ⌘N new page · ⌘1 Home · ⌘2 Calendar." },
  { type: "quote", content: "If I do something more than twice, automate it." },
];

function findProp(props: PropertyDef[], name: string): PropertyDef | undefined {
  const n = name.toLowerCase();
  return props.find((p) => p.name.toLowerCase() === n);
}

export const applyPmUpgrade = mutation({
  args: { tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { doc: settingsDoc, merged: settings } = await getMergedSettings(ctx);
    const did: string[] = [];

    const dbs = await ctx.db.query("databases").collect();
    const tasksDb = dbs.find((d) => d.isTaskSource && d.taskConfig);
    if (!tasksDb) return "no-task-source-database";
    let tasksProps = tasksDb.properties as PropertyDef[];
    const taskConfig = { ...tasksDb.taskConfig! };
    const statusProp = tasksProps.find((p) => p.id === taskConfig.statusPropId);

    // ---------- 1. Dependencies: Blocked by ⇄ Blocking ----------
    let blockedByProp = findProp(tasksProps, "Blocked by");
    if (!blockedByProp) {
      const blockedById = makeId();
      const blockingId = makeId();
      blockedByProp = {
        id: blockedById,
        name: "Blocked by",
        type: "relation",
        relation: { databaseId: tasksDb._id, syncedPropId: blockingId },
      };
      const blocking: PropertyDef = {
        id: blockingId,
        name: "Blocking",
        type: "relation",
        relation: { databaseId: tasksDb._id, syncedPropId: blockedById },
      };
      tasksProps = [...tasksProps, blockedByProp, blocking];
      did.push("dependencies");
    }
    taskConfig.blockedByPropId = blockedByProp.id;

    // ---------- 2. Sub-tasks: Parent task ⇄ Sub-tasks ----------
    let parentProp = findProp(tasksProps, "Parent task");
    if (!parentProp) {
      const parentId = makeId();
      const subtasksId = makeId();
      parentProp = {
        id: parentId,
        name: "Parent task",
        type: "relation",
        relation: { databaseId: tasksDb._id, syncedPropId: subtasksId },
      };
      const subtasks: PropertyDef = {
        id: subtasksId,
        name: "Sub-tasks",
        type: "relation",
        relation: { databaseId: tasksDb._id, syncedPropId: parentId },
      };
      tasksProps = [...tasksProps, parentProp, subtasks];
      did.push("sub-tasks");
    }
    taskConfig.parentPropId = parentProp.id;

    // ---------- 3. Sprints database ----------
    const now = Date.now();
    const tz = args.tzOffsetMin ?? settings.tzOffsetMin;
    let sprintsDb = dbs.find((d) => d.sprintConfig);
    let currentSprintId: Id<"rows"> | undefined;

    if (!sprintsDb) {
      const sprintStatusOptions: SelectOption[] = [
        { id: makeId(), name: "Upcoming", color: "gray" },
        { id: makeId(), name: "Current", color: "orange" },
        { id: makeId(), name: "Completed", color: "green" },
      ];
      const sStatusId = makeId();
      const sDatesId = makeId();
      const sTasksId = makeId(); // relation Sprints -> Tasks
      const tSprintId = makeId(); // synced: Tasks -> Sprint
      const sProgressId = makeId();

      const sprintsProps: PropertyDef[] = [
        { id: "title", name: "Name", type: "title" },
        { id: sStatusId, name: "Status", type: "select", options: sprintStatusOptions },
        { id: sDatesId, name: "Dates", type: "date" },
        {
          id: sTasksId,
          name: "Tasks",
          type: "relation",
          relation: { databaseId: tasksDb._id, syncedPropId: tSprintId },
        },
        {
          id: sProgressId,
          name: "Progress",
          type: "rollup",
          numberFormat: "progress",
          rollup: {
            relationPropId: sTasksId,
            targetPropId: taskConfig.statusPropId,
            aggregate: "percentComplete",
          },
        },
      ];
      const sprintsDbId = await ctx.db.insert("databases", {
        name: "Sprints",
        properties: sprintsProps,
        color: "purple",
        sprintConfig: {
          statusPropId: sStatusId,
          datePropId: sDatesId,
          tasksPropId: sTasksId,
        },
      });
      const sprintsPageId = await ctx.db.insert("pages", {
        title: "Sprints",
        icon: "🏃",
        kind: "database",
        databaseId: sprintsDbId,
        favorite: false,
        trashed: false,
        order: now,
        updatedAt: now,
      });
      await ctx.db.patch(sprintsDbId, { pageId: sprintsPageId });
      await ctx.db.insert("views", { databaseId: sprintsDbId, name: "Table", type: "table", order: 1 });
      await ctx.db.insert("views", {
        databaseId: sprintsDbId,
        name: "Board",
        type: "board",
        groupByPropId: sStatusId,
        order: 2,
      } as never);

      // Tasks side: Sprint relation
      const tSprint: PropertyDef = {
        id: tSprintId,
        name: "Sprint",
        type: "relation",
        relation: { databaseId: sprintsDbId, syncedPropId: sTasksId },
      };
      tasksProps = [...tasksProps, tSprint];
      taskConfig.sprintPropId = tSprintId;

      // Sprint 1 (current, two weeks from today) + Sprint 2 (upcoming)
      const today = localMsToCalendarDate(now, tz);
      const s1Start = today;
      const s1End = today + (SPRINT_LENGTH_DAYS - 1) * DAY_MS;
      currentSprintId = await ctx.db.insert("rows", {
        databaseId: sprintsDbId,
        title: "Sprint 1",
        properties: {
          title: "Sprint 1",
          [sStatusId]: sprintStatusOptions[1].id, // Current
          [sDatesId]: { start: s1Start, end: s1End },
        },
        order: now,
        updatedAt: now,
      });
      await ctx.db.insert("rows", {
        databaseId: sprintsDbId,
        title: "Sprint 2",
        properties: {
          title: "Sprint 2",
          [sStatusId]: sprintStatusOptions[0].id, // Upcoming
          [sDatesId]: { start: s1End + DAY_MS, end: s1End + SPRINT_LENGTH_DAYS * DAY_MS },
        },
        order: now + 1,
        updatedAt: now,
      });

      // Pull open tasks due inside Sprint 1 into it (both relation sides).
      const taskRows = await ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", tasksDb._id))
        .collect();
      const completeIds = new Set(
        (statusProp?.options ?? []).filter((o) => o.group === "complete").map((o) => o.id)
      );
      const inSprint: Id<"rows">[] = [];
      for (const row of taskRows) {
        const sv = row.properties?.[taskConfig.statusPropId];
        if (typeof sv === "string" && completeIds.has(sv)) continue;
        const due = row.properties?.[taskConfig.datePropId] as
          | { start: number; end?: number }
          | undefined;
        if (!due || (due.end ?? due.start) > s1End) continue;
        inSprint.push(row._id);
        await ctx.db.patch(row._id, {
          properties: { ...(row.properties ?? {}), [tSprintId]: [currentSprintId] },
        });
      }
      const sprint1 = await ctx.db.get(currentSprintId);
      if (sprint1) {
        await ctx.db.patch(currentSprintId, {
          properties: { ...(sprint1.properties ?? {}), [sTasksId]: inSprint },
        });
      }
      did.push(`sprints (${inSprint.length} tasks in Sprint 1)`);
    }

    // Persist tasks db changes.
    await ctx.db.patch(tasksDb._id, { properties: tasksProps, taskConfig });

    // ---------- 4. Views: Sprint Board + Backlog ----------
    const taskViews = await ctx.db
      .query("views")
      .withIndex("by_database", (q) => q.eq("databaseId", tasksDb._id))
      .collect();
    const sprintPropId = taskConfig.sprintPropId;
    if (sprintPropId && currentSprintId && !taskViews.some((vw) => vw.name === "Sprint Board")) {
      await ctx.db.insert("views", {
        databaseId: tasksDb._id,
        name: "Sprint Board",
        type: "board",
        groupByPropId: taskConfig.statusPropId,
        filters: {
          conjunction: "and",
          rules: [{ propId: sprintPropId, op: "contains", value: currentSprintId }],
        },
        order: now + 10,
      } as never);
      did.push("sprint-board-view");
    }
    if (sprintPropId && !taskViews.some((vw) => vw.name === "Backlog")) {
      const completeOption = statusProp?.options?.find((o) => o.group === "complete");
      await ctx.db.insert("views", {
        databaseId: tasksDb._id,
        name: "Backlog",
        type: "list",
        filters: {
          conjunction: "and",
          rules: [
            { propId: sprintPropId, op: "isEmpty" },
            ...(completeOption
              ? [{ propId: taskConfig.statusPropId, op: "isNot", value: completeOption.id }]
              : []),
          ],
        },
        sorts: [{ propId: taskConfig.datePropId, dir: "asc" }],
        order: now + 11,
      } as never);
      did.push("backlog-view");
    }

    // ---------- 5. Declutter: hide reverse/secondary relation columns in the
    // default Table view (they stay visible in the row peek) ----------
    const hideIds = [
      blockedByProp.relation?.syncedPropId, // Blocking
      parentProp.id, // Parent task
      parentProp.relation?.syncedPropId, // Sub-tasks
    ].filter((x): x is string => Boolean(x));
    const defaultTable = taskViews.find((vw) => vw.type === "table");
    if (defaultTable && hideIds.length > 0) {
      const hidden = new Set(defaultTable.hiddenPropIds ?? []);
      const before = hidden.size;
      for (const id of hideIds) hidden.add(id);
      if (hidden.size !== before) {
        await ctx.db.patch(defaultTable._id, { hiddenPropIds: [...hidden] });
        did.push("table-decluttered");
      }
    }

    // ---------- 6. In-app User Guide page ----------
    const allPages = await ctx.db.query("pages").collect();
    if (!allPages.some((p) => p.title === "User Guide" && !p.trashed)) {
      await ctx.db.insert("pages", {
        title: "User Guide",
        icon: "📖",
        kind: "doc",
        content: JSON.stringify(USER_GUIDE_BLOCKS),
        favorite: false,
        trashed: false,
        order: now + 100,
        updatedAt: now,
      });
      did.push("user-guide");
    }

    // ---------- 7. Settings flag + reflow ----------
    if (settingsDoc) {
      await ctx.db.patch(settingsDoc._id, { pmUpgraded: true });
    } else {
      await ctx.db.insert("settings", { ...DEFAULT_SETTINGS, pmUpgraded: true });
    }
    await runReflow(ctx, args.tzOffsetMin);
    return did.length > 0 ? `upgraded: ${did.join(", ")}` : "already-up-to-date";
  },
});

/**
 * The Notion "Complete sprint" automation: closes the current sprint, promotes
 * (or creates) the next one, rolls incomplete tasks forward, and retargets any
 * views filtering on the old sprint.
 */
export const completeSprint = mutation({
  args: { sprintsDbId: v.id("databases") },
  handler: async (ctx, args) => {
    const sprintsDb = await ctx.db.get(args.sprintsDbId);
    if (!sprintsDb?.sprintConfig) return "not-a-sprints-database";
    const cfg = sprintsDb.sprintConfig;
    const props = sprintsDb.properties as PropertyDef[];
    const statusProp = props.find((p) => p.id === cfg.statusPropId);
    const opt = (name: string) =>
      statusProp?.options?.find((o) => o.name.toLowerCase() === name)?.id;
    const currentOpt = opt("current");
    const upcomingOpt = opt("upcoming");
    const completedOpt = opt("completed");
    if (!currentOpt || !completedOpt) return "missing-status-options";

    const sprints = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", args.sprintsDbId))
      .collect();
    const current = sprints.find((s) => s.properties?.[cfg.statusPropId] === currentOpt);
    if (!current) return "no-current-sprint";
    const currentDates = current.properties?.[cfg.datePropId] as
      | { start: number; end?: number }
      | undefined;

    // Close it.
    await ctx.db.patch(current._id, {
      properties: { ...(current.properties ?? {}), [cfg.statusPropId]: completedOpt },
      updatedAt: Date.now(),
    });

    // Promote the next upcoming sprint, or create one.
    const lengthMs =
      currentDates?.end !== undefined && currentDates.end > currentDates.start
        ? currentDates.end - currentDates.start
        : (SPRINT_LENGTH_DAYS - 1) * DAY_MS;
    let next = sprints
      .filter(
        (s) =>
          s._id !== current._id &&
          (upcomingOpt === undefined || s.properties?.[cfg.statusPropId] === upcomingOpt)
      )
      .sort(
        (a, b) =>
          ((a.properties?.[cfg.datePropId] as { start?: number } | undefined)?.start ?? 0) -
          ((b.properties?.[cfg.datePropId] as { start?: number } | undefined)?.start ?? 0)
      )[0];

    let nextId: Id<"rows">;
    if (next) {
      nextId = next._id;
      await ctx.db.patch(next._id, {
        properties: { ...(next.properties ?? {}), [cfg.statusPropId]: currentOpt },
        updatedAt: Date.now(),
      });
    } else {
      const m = /(\d+)\s*$/.exec(current.title);
      const title = m ? `Sprint ${Number(m[1]) + 1}` : `${current.title} →`;
      const start = (currentDates?.end ?? currentDates?.start ?? Date.now()) + DAY_MS;
      nextId = await ctx.db.insert("rows", {
        databaseId: args.sprintsDbId,
        title,
        properties: {
          title,
          [cfg.statusPropId]: currentOpt,
          [cfg.datePropId]: { start, end: start + lengthMs },
        },
        order: Date.now(),
        updatedAt: Date.now(),
      });
      next = (await ctx.db.get(nextId))!;
    }

    // Roll incomplete tasks forward (maintaining both relation sides).
    const tasksDb = await ctx.db.get(
      (props.find((p) => p.id === cfg.tasksPropId)?.relation?.databaseId ??
        "") as Id<"databases">
    );
    let moved = 0;
    if (tasksDb?.taskConfig) {
      const tStatusProp = (tasksDb.properties as PropertyDef[]).find(
        (p) => p.id === tasksDb.taskConfig!.statusPropId
      );
      const completeIds = new Set(
        (tStatusProp?.options ?? []).filter((o) => o.group === "complete").map((o) => o.id)
      );
      const sprintPropId =
        (props.find((p) => p.id === cfg.tasksPropId)?.relation?.syncedPropId ??
          tasksDb.taskConfig.sprintPropId) as string | undefined;
      const taskIds = ((current.properties?.[cfg.tasksPropId] ?? []) as string[]).slice();
      const stay: string[] = [];
      const movedIds: string[] = [];
      for (const id of taskIds) {
        const task = await ctx.db.get(id as Id<"rows">);
        if (!task) continue;
        const sv = task.properties?.[tasksDb.taskConfig.statusPropId];
        const isDone = typeof sv === "string" && completeIds.has(sv);
        if (isDone || !sprintPropId) {
          stay.push(id);
          continue;
        }
        movedIds.push(id);
        await ctx.db.patch(task._id, {
          properties: {
            ...(task.properties ?? {}),
            [sprintPropId]: [
              ...((task.properties?.[sprintPropId] ?? []) as string[]).filter(
                (x) => x !== current._id
              ),
              nextId,
            ],
          },
          updatedAt: Date.now(),
        });
        moved++;
      }
      // Update sprint rows' task arrays.
      const cur2 = await ctx.db.get(current._id);
      if (cur2) {
        await ctx.db.patch(current._id, {
          properties: { ...(cur2.properties ?? {}), [cfg.tasksPropId]: stay },
        });
      }
      const next2 = await ctx.db.get(nextId);
      if (next2) {
        const existing = (next2.properties?.[cfg.tasksPropId] ?? []) as string[];
        await ctx.db.patch(nextId, {
          properties: {
            ...(next2.properties ?? {}),
            [cfg.tasksPropId]: [...existing, ...movedIds.filter((x) => !existing.includes(x))],
          },
        });
      }

      // Retarget views filtering on the old sprint.
      const views = await ctx.db
        .query("views")
        .withIndex("by_database", (q) => q.eq("databaseId", tasksDb._id))
        .collect();
      for (const view of views) {
        const filters = view.filters as
          | { conjunction: string; rules: Array<{ propId: string; op: string; value?: unknown }> }
          | undefined;
        if (!filters?.rules?.some((r) => r.value === current._id)) continue;
        await ctx.db.patch(view._id, {
          filters: {
            ...filters,
            rules: filters.rules.map((r) =>
              r.value === current._id ? { ...r, value: nextId } : r
            ),
          },
        });
      }
    }

    return `completed "${current.title}" → "${next.title}" (${moved} open task${moved === 1 ? "" : "s"} rolled forward)`;
  },
});
