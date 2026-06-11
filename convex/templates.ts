import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DateValue, PropertyDef, TemplatePayload } from "./lib/types";
import { DAY_MS, localMsToCalendarDate } from "./lib/scheduler";
import { getMergedSettings, runReflow } from "./scheduling";

// WHAT: Project templates — capture a live project (tasks become relative day
// offsets) and stamp out new ones; instantiated tasks auto-schedule via reflow.

interface PmWiring {
  tasksDb: Doc<"databases">;
  projectsDb: Doc<"databases">;
  /** relation prop on tasks → projects */
  taskProjectPropId: string;
  /** synced reverse on projects → tasks */
  projectTasksPropId: string;
}

/** Resolve the Projects⇄Tasks wiring from the live schema (no baked-in ids). */
async function resolvePmWiring(ctx: QueryCtx | MutationCtx): Promise<PmWiring> {
  const dbs = await ctx.db.query("databases").collect();
  const tasksDb = dbs.find((d) => d.isTaskSource && d.taskConfig);
  if (!tasksDb) throw new Error("No task-source database found");
  const taskProps = tasksDb.properties as PropertyDef[];
  const projectRel = taskProps.find(
    (p) =>
      p.type === "relation" &&
      p.relation?.syncedPropId &&
      p.relation.databaseId !== tasksDb._id &&
      !dbs.find((d) => d._id === p.relation!.databaseId)?.sprintConfig
  );
  if (!projectRel?.relation) throw new Error("Tasks database has no project relation");
  const projectsDb = dbs.find((d) => d._id === projectRel.relation!.databaseId);
  if (!projectsDb) throw new Error("Projects database not found");
  return {
    tasksDb,
    projectsDb,
    taskProjectPropId: projectRel.id,
    projectTasksPropId: projectRel.relation.syncedPropId!,
  };
}

const firstTodoOption = (db: Doc<"databases">, propId: string) =>
  (db.properties as PropertyDef[])
    .find((p) => p.id === propId)
    ?.options?.find((o) => o.group === "todo");

export const list = query({
  args: {},
  handler: async (ctx) => {
    const templates = await ctx.db.query("templates").collect();
    return templates
      .filter((t) => !t.trashed)
      .map((t) => ({
        templateId: t._id,
        name: t.name,
        description: t.description,
        icon: t.icon,
        category: t.category,
        seeded: t.seeded ?? false,
        taskCount: (t.payload as TemplatePayload).tasks.length,
      }));
  },
});

/** Capture a live project row + its tasks as a reusable template. */
export const saveFromProject = mutation({
  args: {
    projectRowId: v.id("rows"),
    name: v.string(),
    description: v.optional(v.string()),
    icon: v.optional(v.string()),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const wiring = await resolvePmWiring(ctx);
    const project = await ctx.db.get(args.projectRowId);
    if (!project || project.databaseId !== wiring.projectsDb._id) {
      throw new Error("Row is not a project");
    }
    const { merged: settings } = await getMergedSettings(ctx);
    const tz = args.tzOffsetMin ?? settings.tzOffsetMin;
    const today = localMsToCalendarDate(Date.now(), tz);
    const tc = wiring.tasksDb.taskConfig!;
    const taskProps = wiring.tasksDb.properties as PropertyDef[];
    const priorityProp = taskProps.find((p) => p.id === tc.priorityPropId);
    const projDateProp = (wiring.projectsDb.properties as PropertyDef[]).find(
      (p) => p.type === "date"
    );

    const offsetOf = (dv: DateValue | undefined) =>
      dv && typeof dv.start === "number"
        ? Math.round(((dv.end ?? dv.start) - today) / DAY_MS)
        : undefined;

    const taskIds = ((project.properties?.[wiring.projectTasksPropId] ?? []) as string[]);
    const titleOf = new Map<string, string>();
    const taskDocs: Doc<"rows">[] = [];
    for (const id of taskIds) {
      const t = await ctx.db.get(id as Id<"rows">);
      if (t) {
        taskDocs.push(t);
        titleOf.set(t._id, t.title);
      }
    }

    const payload: TemplatePayload = {
      targetOffsetDays: projDateProp
        ? offsetOf(project.properties?.[projDateProp.id] as DateValue | undefined)
        : undefined,
      projectContent: project.content,
      tasks: taskDocs.map((t) => {
        const p = t.properties ?? {};
        const blockedBy = tc.blockedByPropId
          ? ((p[tc.blockedByPropId] ?? []) as string[])
              .map((id) => titleOf.get(id))
              .filter((x): x is string => Boolean(x))
          : [];
        return {
          title: t.title,
          priorityName: priorityProp?.options?.find((o) => o.id === p[tc.priorityPropId])?.name,
          estimateMin:
            typeof p[tc.estimatePropId] === "number" ? (p[tc.estimatePropId] as number) : undefined,
          dueOffsetDays: offsetOf(p[tc.datePropId] as DateValue | undefined),
          blockedByTitles: blockedBy.length ? blockedBy : undefined,
          content: t.content,
        };
      }),
    };

    return ctx.db.insert("templates", {
      name: args.name.trim() || project.title || "Untitled template",
      description: args.description,
      icon: args.icon ?? "📦",
      category: "custom",
      payload,
    });
  },
});

/** Stamp out a template: project + tasks with offset dates + dependency chains. */
export const instantiate = mutation({
  args: {
    templateId: v.id("templates"),
    title: v.string(),
    startDay: v.number(), // calendar date (UTC midnight ms)
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const template = await ctx.db.get(args.templateId);
    if (!template || template.trashed) throw new Error("Template not found");
    const payload = template.payload as TemplatePayload;
    const wiring = await resolvePmWiring(ctx);
    const tc = wiring.tasksDb.taskConfig!;
    const taskProps = wiring.tasksDb.properties as PropertyDef[];
    const projProps = wiring.projectsDb.properties as PropertyDef[];
    const priorityProp = taskProps.find((p) => p.id === tc.priorityPropId);
    const projStatusProp = projProps.find((p) => p.type === "status");
    const projDateProp = projProps.find((p) => p.type === "date");
    const now = Date.now();
    let order = now;

    // Project row
    const projectProperties: Record<string, unknown> = { title: args.title };
    const projTodo = projStatusProp?.options?.find((o) => o.group === "todo");
    if (projStatusProp && projTodo) projectProperties[projStatusProp.id] = projTodo.id;
    if (projDateProp && payload.targetOffsetDays !== undefined) {
      projectProperties[projDateProp.id] = {
        start: args.startDay + payload.targetOffsetDays * DAY_MS,
      };
    }
    const projectRowId = await ctx.db.insert("rows", {
      databaseId: wiring.projectsDb._id,
      title: args.title,
      properties: projectProperties,
      content: payload.projectContent,
      order: ++order,
      updatedAt: now,
    });

    // Task rows
    const taskTodo = firstTodoOption(wiring.tasksDb, tc.statusPropId);
    const idByTitle = new Map<string, Id<"rows">>();
    const taskIds: Id<"rows">[] = [];
    for (const t of payload.tasks) {
      const properties: Record<string, unknown> = {
        title: t.title,
        [wiring.taskProjectPropId]: [projectRowId],
      };
      if (taskTodo) properties[tc.statusPropId] = taskTodo.id;
      if (t.estimateMin !== undefined) properties[tc.estimatePropId] = t.estimateMin;
      if (t.dueOffsetDays !== undefined) {
        properties[tc.datePropId] = { start: args.startDay + t.dueOffsetDays * DAY_MS };
      }
      if (t.priorityName && priorityProp) {
        const opt = priorityProp.options?.find(
          (o) => o.name.toLowerCase() === t.priorityName!.toLowerCase()
        );
        if (opt) properties[tc.priorityPropId] = opt.id;
      }
      const rowId = await ctx.db.insert("rows", {
        databaseId: wiring.tasksDb._id,
        title: t.title,
        properties,
        content: t.content,
        order: ++order,
        updatedAt: now,
      });
      idByTitle.set(t.title, rowId);
      taskIds.push(rowId);
    }

    // Dependency chains (maintain BOTH sides of the synced pair).
    const blockedByPropId = tc.blockedByPropId;
    const blockingPropId = blockedByPropId
      ? taskProps.find((p) => p.id === blockedByPropId)?.relation?.syncedPropId
      : undefined;
    if (blockedByPropId && blockingPropId) {
      const blockingOf = new Map<Id<"rows">, Id<"rows">[]>();
      for (const t of payload.tasks) {
        if (!t.blockedByTitles?.length) continue;
        const rowId = idByTitle.get(t.title)!;
        const blockerIds = t.blockedByTitles
          .map((title) => idByTitle.get(title))
          .filter((x): x is Id<"rows"> => Boolean(x));
        if (blockerIds.length === 0) continue;
        const row = await ctx.db.get(rowId);
        await ctx.db.patch(rowId, {
          properties: { ...(row!.properties ?? {}), [blockedByPropId]: blockerIds },
        });
        for (const b of blockerIds) {
          blockingOf.set(b, [...(blockingOf.get(b) ?? []), rowId]);
        }
      }
      for (const [blockerId, blockedIds] of blockingOf) {
        const blocker = await ctx.db.get(blockerId);
        await ctx.db.patch(blockerId, {
          properties: { ...(blocker!.properties ?? {}), [blockingPropId]: blockedIds },
        });
      }
    }

    // Reverse relation on the project.
    const project = await ctx.db.get(projectRowId);
    await ctx.db.patch(projectRowId, {
      properties: { ...(project!.properties ?? {}), [wiring.projectTasksPropId]: taskIds },
    });

    await runReflow(ctx, args.tzOffsetMin);
    return {
      projectRowId,
      taskIds,
      projectsPageId: wiring.projectsDb.pageId ?? null,
    };
  },
});

export const removeTemplate = mutation({
  args: { templateId: v.id("templates") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.templateId, { trashed: true });
  },
});

// ---------- seeded starter templates ----------

const STARTERS: Array<{
  name: string;
  description: string;
  icon: string;
  category: string;
  payload: TemplatePayload;
}> = [
  {
    name: "ASTGL Article",
    description: "Research → draft → review → publish, chained so each step waits for the last.",
    icon: "✍️",
    category: "content",
    payload: {
      targetOffsetDays: 8,
      projectContent: JSON.stringify([
        { type: "heading", props: { level: 2 }, content: "Article brief" },
        { type: "bulletListItem", content: "Working title:" },
        { type: "bulletListItem", content: "The one thing the reader should take away:" },
        { type: "bulletListItem", content: "Receipts/screenshots to capture:" },
      ]),
      tasks: [
        { title: "Research + outline", priorityName: "High", estimateMin: 60, dueOffsetDays: 2 },
        { title: "Write first draft", priorityName: "High", estimateMin: 180, dueOffsetDays: 5, blockedByTitles: ["Research + outline"] },
        { title: "Edit + graphics", priorityName: "Medium", estimateMin: 60, dueOffsetDays: 7, blockedByTitles: ["Write first draft"] },
        { title: "Publish + notes campaign", priorityName: "High", estimateMin: 45, dueOffsetDays: 8, blockedByTitles: ["Edit + graphics"] },
      ],
    },
  },
  {
    name: "Podcast Episode",
    description: "Outline, record, edit, show notes, publish — a full episode cycle.",
    icon: "🎙️",
    category: "content",
    payload: {
      targetOffsetDays: 9,
      tasks: [
        { title: "Outline episode", priorityName: "Medium", estimateMin: 45, dueOffsetDays: 2 },
        { title: "Record", priorityName: "High", estimateMin: 90, dueOffsetDays: 4, blockedByTitles: ["Outline episode"] },
        { title: "Edit audio", priorityName: "Medium", estimateMin: 120, dueOffsetDays: 7, blockedByTitles: ["Record"] },
        { title: "Write show notes", priorityName: "Low", estimateMin: 30, dueOffsetDays: 8, blockedByTitles: ["Record"] },
        { title: "Publish episode", priorityName: "High", estimateMin: 30, dueOffsetDays: 9, blockedByTitles: ["Edit audio", "Write show notes"] },
      ],
    },
  },
  {
    // Designed by ARCHITECT in-app (2026-06-10) as "IT Upgrade Project
    // [REFERENCE TEMPLATE]"; promoted to a seeded starter here. The task
    // chain, priorities, estimates, and dependency graph mirror that design.
    name: "IT Upgrade Project",
    description:
      "ITIL-style change: scope → CAB approval → parallel prep (backup, staging, vendor) → maintenance-window execution → validation → docs.",
    icon: "🛠️",
    category: "it",
    payload: {
      targetOffsetDays: 21,
      projectContent: JSON.stringify([
        { type: "heading", props: { level: 2 }, content: "Change brief" },
        { type: "bulletListItem", content: "System / version (from → to):" },
        { type: "bulletListItem", content: "Maintenance window:" },
        { type: "bulletListItem", content: "Change ticket / CAB reference:" },
        { type: "bulletListItem", content: "Rollback decision point:" },
      ]),
      tasks: [
        { title: "Scope & requirements doc", priorityName: "High", estimateMin: 120, dueOffsetDays: 3 },
        { title: "Stakeholder identification & notification", priorityName: "Medium", estimateMin: 60, dueOffsetDays: 3 },
        { title: "Risk assessment", priorityName: "High", estimateMin: 90, dueOffsetDays: 3 },
        { title: "Change request / CAB submission", priorityName: "Urgent", estimateMin: 60, dueOffsetDays: 5, blockedByTitles: ["Scope & requirements doc", "Stakeholder identification & notification", "Risk assessment"] },
        { title: "Rollback plan / runbook", priorityName: "High", estimateMin: 120, dueOffsetDays: 10, blockedByTitles: ["Change request / CAB submission"] },
        { title: "Resource & schedule planning", priorityName: "Medium", estimateMin: 60, dueOffsetDays: 10, blockedByTitles: ["Change request / CAB submission"] },
        { title: "Vendor coordination (licensing / delivery)", priorityName: "Medium", estimateMin: 45, dueOffsetDays: 10, blockedByTitles: ["Change request / CAB submission"] },
        { title: "Backup verification", priorityName: "Urgent", estimateMin: 60, dueOffsetDays: 11, blockedByTitles: ["Change request / CAB submission"] },
        { title: "Staging / test environment validation", priorityName: "High", estimateMin: 180, dueOffsetDays: 11, blockedByTitles: ["Change request / CAB submission"] },
        { title: "Execute upgrade (maintenance window)", priorityName: "Urgent", estimateMin: 240, dueOffsetDays: 14, blockedByTitles: ["Backup verification", "Staging / test environment validation", "Vendor coordination (licensing / delivery)"] },
        { title: "Smoke testing / validation", priorityName: "Urgent", estimateMin: 90, dueOffsetDays: 15, blockedByTitles: ["Execute upgrade (maintenance window)"] },
        { title: "24–48hr post-upgrade monitoring", priorityName: "High", estimateMin: 60, dueOffsetDays: 17, blockedByTitles: ["Execute upgrade (maintenance window)", "Smoke testing / validation"] },
        { title: "Documentation update", priorityName: "Medium", estimateMin: 90, dueOffsetDays: 19, blockedByTitles: ["24–48hr post-upgrade monitoring"] },
        { title: "Lessons learned / ticket closure", priorityName: "Low", estimateMin: 45, dueOffsetDays: 21, blockedByTitles: ["24–48hr post-upgrade monitoring"] },
      ],
    },
  },
  {
    name: "Home-Lab Project",
    description: "Design, provision, configure, document — the responsible-sysadmin loop.",
    icon: "🖥️",
    category: "homelab",
    payload: {
      targetOffsetDays: 14,
      tasks: [
        { title: "Design + research", priorityName: "Medium", estimateMin: 120, dueOffsetDays: 4 },
        { title: "Provision hardware/VMs", priorityName: "Medium", estimateMin: 90, dueOffsetDays: 7, blockedByTitles: ["Design + research"] },
        { title: "Configure + harden", priorityName: "High", estimateMin: 150, dueOffsetDays: 11, blockedByTitles: ["Provision hardware/VMs"] },
        { title: "Document the build", priorityName: "Low", estimateMin: 60, dueOffsetDays: 14, blockedByTitles: ["Configure + harden"] },
      ],
    },
  },
];

/** Idempotent (by name) — safe to call from applyPmUpgrade repeatedly. */
export async function seedTemplatesHelper(ctx: MutationCtx): Promise<number> {
  const existing = await ctx.db.query("templates").collect();
  const names = new Set(existing.map((t) => t.name));
  let added = 0;
  for (const s of STARTERS) {
    if (names.has(s.name)) continue;
    await ctx.db.insert("templates", { ...s, seeded: true });
    added++;
  }
  return added;
}

export const seedTemplates = mutation({
  args: {},
  handler: async (ctx) => {
    const added = await seedTemplatesHelper(ctx);
    return added > 0 ? `seeded ${added} templates` : "already-seeded";
  },
});
