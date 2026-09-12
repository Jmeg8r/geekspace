import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { DEFAULT_SETTINGS } from "../convex/lib/defaults";
import { MIN_MS } from "../convex/lib/scheduler";
const modules = import.meta.glob("../convex/**/*.ts");
const fresh = () => convexTest(schema, modules);

async function relationFixture() {
  const t = fresh();
  const ids = await t.run(async (ctx) => {
    const a = await ctx.db.insert("databases", { name: "A", properties: [] });
    const b = await ctx.db.insert("databases", { name: "B", properties: [] });
    await ctx.db.patch(a, {
      properties: [
        { id: "title", type: "title", name: "Name" },
        {
          id: "rel",
          type: "relation",
          name: "Related",
          relation: { databaseId: b, syncedPropId: "back" },
        },
      ],
    });
    await ctx.db.patch(b, {
      properties: [
        { id: "title", type: "title", name: "Name" },
        {
          id: "back",
          type: "relation",
          name: "Back",
          relation: { databaseId: a, syncedPropId: "rel" },
        },
      ],
    });
    const target = await ctx.db.insert("rows", {
      databaseId: b,
      title: "target",
      properties: { title: "target" },
      order: 0,
      updatedAt: 0,
    });
    return { a, b, target };
  });
  return { t, ...ids };
}

describe("mutation integrity", () => {
  it("rolls back all property edits when one relation points outside its database", async () => {
    const { t, a } = await relationFixture();
    const source = await t.mutation(api.rows.create, {
      databaseId: a,
      properties: { title: "Original" },
    });
    if (!source) throw new Error("fixture row missing");
    await expect(
      t.mutation(api.rows.updateProperties, {
        rowId: source,
        properties: { title: "Changed", rel: [source] },
      }),
    ).rejects.toThrow();
    expect((await t.run((ctx) => ctx.db.get(source)))?.title).toBe("Original");
  });
  it("preserves manual notes when reprocessing a meeting", async () => {
    const t = fresh();
    const meetingId = await t.mutation(api.meetings.start, {
      title: "Fixture",
    });
    const summary = {
      meetingId,
      summary: "Generated",
      keyPoints: [],
      decisions: [],
      actionItems: [],
    };
    await t.mutation(api.meetings.finishSummary, summary);
    const first = await t.query(api.meetings.get, { meetingId });
    if (!first?.pageId) throw new Error("missing notes page");
    await t.mutation(api.pages.setContent, {
      pageId: first.pageId,
      content: '[{"type":"paragraph","content":"My edits"}]',
    });
    await t.mutation(api.meetings.finishSummary, {
      ...summary,
      summary: "Regenerated",
    });
    const second = await t.query(api.meetings.get, { meetingId });
    expect(second?.pageId).not.toBe(first.pageId);
    expect(
      (await t.query(api.pages.get, { pageId: first.pageId }))?.content,
    ).toContain("My edits");
    await t.mutation(api.meetings.finishSummary, {
      ...summary,
      summary: "Third result",
    });
    expect((await t.query(api.meetings.get, { meetingId }))?.pageId).toBe(
      second?.pageId,
    );
  });
  it("keeps existing calendar mirrors when a sync has invalid dates", async () => {
    const t = fresh();
    const now = Date.now();
    const event = {
      externalId: "fixture",
      title: "Fixture",
      start: now,
      end: now + 60000,
    };
    const window = { windowStart: now - 1, windowEnd: now + 86400000 };
    await t.mutation(api.events.syncExternal, { ...window, items: [event] });
    await expect(
      t.mutation(api.events.syncExternal, {
        ...window,
        items: [{ ...event, end: NaN }],
      }),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("events").collect())).toHaveLength(
      1,
    );
  });
  it("includes an appointment that began more than 35 days ago", async () => {
    const t = fresh();
    const now = Date.now();
    await t.mutation(api.events.create, {
      title: "Long appointment",
      start: now - 40 * 86400000,
      end: now + 86400000,
    });
    expect(
      await t.query(api.events.listRange, { start: now, end: now + 3600000 }),
    ).toHaveLength(1);
  });

  it("synchronizes relations supplied during creation", async () => {
    const { t, a, target } = await relationFixture();
    const source = await t.mutation(api.rows.create, {
      databaseId: a,
      properties: { title: "source", rel: [target] },
    });
    expect((await t.run((ctx) => ctx.db.get(target)))?.properties.back).toEqual(
      [source],
    );
  });
  it("cleans reverse relations when deleting a row", async () => {
    const { t, a, target } = await relationFixture();
    const source = await t.mutation(api.rows.create, { databaseId: a });
    if (!source) throw new Error("fixture row missing");
    await t.mutation(api.rows.updateProperty, {
      rowId: source,
      propId: "rel",
      value: [target],
    });
    await t.mutation(api.rows.remove, { rowId: source });
    expect(
      (await t.run((ctx) => ctx.db.get(target)))?.properties.back ?? [],
    ).toEqual([]);
  });
  it("rejects malformed property values before they can poison queries", async () => {
    const { t, a } = await relationFixture();
    await expect(
      t.mutation(api.rows.create, {
        databaseId: a,
        properties: { rel: "bad" },
      }),
    ).rejects.toThrow();
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("rows")
          .withIndex("by_database", (q) => q.eq("databaseId", a))
          .collect(),
      ),
    ).toEqual([]);
  });
  it("removes both halves and values of a self relation", async () => {
    const { t, a } = await relationFixture();
    const id = await t.mutation(api.databases.addProperty, {
      databaseId: a,
      type: "relation",
      targetDatabaseId: a,
      name: "Parent",
    });
    if (!id) throw new Error("fixture property missing");
    const before = await t.query(api.databases.get, { databaseId: a });
    const reverse = before?.properties.find((p) => p.id === id)?.relation
      .syncedPropId;
    await t.mutation(api.databases.removeProperty, {
      databaseId: a,
      propId: id,
    });
    expect(
      (await t.query(api.databases.get, { databaseId: a }))?.properties.some(
        (p) => p.id === reverse,
      ),
    ).toBe(false);
  });
  it("rejects non-finite scheduler values without committing them", async () => {
    const t = fresh();
    await expect(
      t.mutation(api.settings.update, { horizonDays: NaN }),
    ).rejects.toThrow();
    expect((await t.query(api.settings.get, {})).horizonDays).toBe(
      DEFAULT_SETTINGS.horizonDays,
    );
  });
  it("counts pinned work once in the estimate", async () => {
    const t = fresh();
    const now = Date.now();
    const { row, pin } = await t.run(async (ctx) => {
      await ctx.db.insert("settings", {
        ...DEFAULT_SETTINGS,
        workDays: [0, 1, 2, 3, 4, 5, 6],
        dayStartMin: 0,
        dayEndMin: 1440,
        bufferMin: 0,
      });
      const db = await ctx.db.insert("databases", {
        name: "Tasks",
        isTaskSource: true,
        taskConfig: {
          statusPropId: "status",
          datePropId: "due",
          estimatePropId: "estimate",
          priorityPropId: "priority",
        },
        properties: [],
      });
      const row = await ctx.db.insert("rows", {
        databaseId: db,
        title: "Pinned",
        properties: {
          estimate: 60,
          due: { start: now + 2 * 86400000, includeTime: true },
        },
        order: 0,
        updatedAt: now,
      });
      const pin = await ctx.db.insert("timeBlocks", {
        databaseId: db,
        taskRowId: row,
        start: now + 60 * MIN_MS,
        end: now + 120 * MIN_MS,
        locked: true,
      });
      return { row, pin };
    });
    await t.mutation(api.scheduling.reflowNow, {});
    const blocks = await t.run((ctx) =>
      ctx.db
        .query("timeBlocks")
        .withIndex("by_task", (q) => q.eq("taskRowId", row))
        .collect(),
    );
    expect(blocks.map((b) => b._id)).toEqual([pin]);
  });
});

it("keeps seeded project, sprint and template workflows consistent", async () => {
  const t = fresh();
  expect(await t.mutation(api.seed.seedWorkspace, {})).toBe("seeded");
  expect(await t.mutation(api.seed.seedWorkspace, {})).toBe("already-seeded");
  await t.mutation(api.pm.applyPmUpgrade, {});
  const databases = await t.query(api.databases.listAll, {});
  const tasks = databases.find((database) => database.isTaskSource);
  const sprints = databases.find((database) => database.sprintConfig);
  if (!tasks || !sprints) throw new Error("Missing fixture databases");
  const templates = await t.query(api.templates.list, {});
  expect(templates.length).toBeGreaterThan(0);
  const instantiated = await t.mutation(api.templates.instantiate, {
    templateId: templates[0].templateId,
    title: "Synthetic project",
    startDay: Date.UTC(2026, 8, 12),
  });
  expect(instantiated.taskIds.length).toBeGreaterThan(0);
  expect(
    (await t.query(api.rows.list, { databaseId: tasks._id })).rows.length,
  ).toBeGreaterThan(instantiated.taskIds.length);
  expect(
    await t.mutation(api.pm.completeSprint, { sprintsDbId: sprints._id }),
  ).toContain("completed");
  const refreshed = await t.query(api.databases.get, { databaseId: tasks._id });
  if (!refreshed?.taskConfig) throw new Error("Missing task mapping");
  await t.mutation(api.databases.setTaskSource, {
    databaseId: tasks._id,
    isTaskSource: true,
    taskConfig: refreshed.taskConfig,
  });
  expect(
    (await t.query(api.databases.get, { databaseId: tasks._id }))?.taskConfig
      ?.blockedByPropId,
  ).toBe(refreshed.taskConfig.blockedByPropId);
});
