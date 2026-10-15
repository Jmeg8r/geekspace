import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { PropertyDef } from "../convex/lib/types";
import { relationIds, type PropertyValue } from "../convex/lib/rowProperties";

// WHAT: row and relation integrity: two-sided relations on create, clean deletes, whole
// self-relation removal, validated values, task-source wiring that survives a toggle.
// Several cases are ported from PR #28's tests/databaseIntegrity.test.ts.
// See docs/changes/2026-10-15-row-integrity/.

const modules = import.meta.glob("../convex/**/*.ts");

type Seeded = {
  t: ReturnType<typeof convexTest>;
  tasks: Doc<"databases">;
  projects: Doc<"databases">;
  prop: (db: Doc<"databases">, name: string) => PropertyDef;
  firstRow: (db: Doc<"databases">) => Promise<Doc<"rows">>;
  rowsOf: (db: Doc<"databases">) => Promise<Doc<"rows">[]>;
  row: (id: Id<"rows">) => Promise<Doc<"rows"> | null>;
  database: (id: Id<"databases">) => Promise<Doc<"databases"> | null>;
};

async function seeded(): Promise<Seeded> {
  const t = convexTest(schema, modules);
  await t.mutation(api.seed.seedWorkspace, {});
  const dbs = await t.run((ctx) => ctx.db.query("databases").collect());
  const tasks = dbs.find((d) => d.isTaskSource);
  const projects = dbs.find((d) => d.name === "Projects");
  if (!tasks || !projects) throw new Error("seed did not create Tasks and Projects");
  const prop = (db: Doc<"databases">, name: string) => {
    const props: PropertyDef[] = db.properties;
    const found = props.find((p) => p.name === name);
    if (!found) throw new Error(`no property "${name}" on ${db.name}`);
    return found;
  };
  const rowsOf = (db: Doc<"databases">) =>
    t.run((ctx) =>
      ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", db._id))
        .collect()
    );
  const firstRow = async (db: Doc<"databases">) => {
    const rows = await rowsOf(db);
    if (!rows[0]) throw new Error(`no rows in ${db.name}`);
    return rows[0];
  };
  const row = (id: Id<"rows">) => t.run((ctx) => ctx.db.get(id));
  const database = (id: Id<"databases">) => t.run((ctx) => ctx.db.get(id));
  return { t, tasks, projects, prop, firstRow, rowsOf, row, database };
}

const ids = (value: PropertyValue | undefined): string[] => relationIds(value);

describe("rows.create", () => {
  it("syncs the reverse side of relations given at creation", async () => {
    const s = await seeded();
    const project = await s.firstRow(s.projects);
    const projectProp = s.prop(s.tasks, "Project");
    const rowId = await s.t.mutation(api.rows.create, {
      databaseId: s.tasks._id,
      properties: { title: "Created with a project", [projectProp.id]: [project._id] },
    });
    if (!rowId) throw new Error("create returned null");
    const after = await s.row(project._id);
    expect(ids(after?.properties[projectProp.relation?.syncedPropId ?? ""])).toContain(rowId);
  });

  it("rejects a value that does not fit its property, and writes nothing", async () => {
    const s = await seeded();
    const status = s.prop(s.tasks, "Status");
    const before = await s.t.run((ctx) => ctx.db.query("rows").collect());
    await expect(
      s.t.mutation(api.rows.create, {
        databaseId: s.tasks._id,
        properties: { title: "Bad", [status.id]: "no-such-option" },
      })
    ).rejects.toThrow();
    const after = await s.t.run((ctx) => ctx.db.query("rows").collect());
    expect(after.length).toBe(before.length);
  });
});

describe("rows.updateProperty / updateProperties", () => {
  it("rejects a relation target from another database and rolls back the whole batch", async () => {
    const s = await seeded();
    const task = await s.firstRow(s.tasks);
    const otherTask = (
      await s.rowsOf(s.tasks)
    )[1];
    const projectProp = s.prop(s.tasks, "Project");
    await expect(
      s.t.mutation(api.rows.updateProperties, {
        rowId: task._id,
        changes: { title: "Renamed in a failing batch", [projectProp.id]: [otherTask._id] },
      })
    ).rejects.toThrow();
    expect((await s.row(task._id))?.title).toBe(task.title);
  });

  it("rejects a malformed date", async () => {
    const s = await seeded();
    const task = await s.firstRow(s.tasks);
    const due = s.prop(s.tasks, "Due");
    await expect(
      s.t.mutation(api.rows.updateProperty, {
        rowId: task._id,
        propId: due.id,
        value: { start: Number.POSITIVE_INFINITY },
      })
    ).rejects.toThrow();
  });

  it("writes the forward side when the reverse definition is broken, instead of throwing", async () => {
    const s = await seeded();
    const blockedBy = s.prop(s.tasks, "Blocked by");
    // Simulate a half-pair left behind by the old removeProperty.
    await s.t.run(async (ctx) => {
      const db = await ctx.db.get(s.tasks._id);
      if (!db) throw new Error("tasks missing");
      const props: PropertyDef[] = db.properties;
      await ctx.db.patch(db._id, {
        properties: props.filter((p) => p.id !== blockedBy.relation?.syncedPropId),
      });
    });
    const [a, b] = await s.rowsOf(s.tasks);
    await s.t.mutation(api.rows.updateProperty, {
      rowId: a._id,
      propId: blockedBy.id,
      value: [b._id],
    });
    expect(ids((await s.row(a._id))?.properties[blockedBy.id])).toEqual([b._id]);
  });
});

describe("rows.remove", () => {
  it("clears the deleted row from every relation that pointed at it", async () => {
    const s = await seeded();
    const projectProp = s.prop(s.tasks, "Project");
    const reverseId = projectProp.relation?.syncedPropId ?? "";
    const project = await s.firstRow(s.projects);
    const linked = ids(project.properties[reverseId]);
    expect(linked.length).toBeGreaterThan(0);
    // SAFETY: the reverse side of a rows relation stores rows ids.
    const victim = linked[0] as Id<"rows">;
    await s.t.mutation(api.rows.remove, { rowId: victim });
    expect(ids((await s.row(project._id))?.properties[reverseId])).not.toContain(victim);
  });
});

describe("databases.removeProperty", () => {
  it("removes both halves of a self-relation and their values", async () => {
    const s = await seeded();
    const blockedBy = s.prop(s.tasks, "Blocked by");
    const blockingId = blockedBy.relation?.syncedPropId ?? "";
    await s.t.mutation(api.databases.removeProperty, {
      databaseId: s.tasks._id,
      propId: blockedBy.id,
    });
    const db = await s.database(s.tasks._id);
    const remaining: PropertyDef[] = db?.properties ?? [];
    expect(remaining.map((p) => p.id)).not.toContain(blockingId);
    const rows = await s.rowsOf(s.tasks);
    for (const r of rows) {
      expect(r.properties).not.toHaveProperty(blockedBy.id);
      expect(r.properties).not.toHaveProperty(blockingId);
    }
  });
});

describe("databases.setTaskSource", () => {
  it("keeps the dependency, parent and sprint wiring across an off/on toggle", async () => {
    const s = await seeded();
    const before = (await s.database(s.tasks._id))?.taskConfig;
    expect(before?.blockedByPropId).toBeTruthy();
    // What the UI sends: off with no config, then on with the four auto-detected fields.
    await s.t.mutation(api.databases.setTaskSource, {
      databaseId: s.tasks._id,
      isTaskSource: false,
      taskConfig: undefined,
    });
    await s.t.mutation(api.databases.setTaskSource, {
      databaseId: s.tasks._id,
      isTaskSource: true,
      taskConfig: {
        statusPropId: before?.statusPropId ?? "",
        datePropId: before?.datePropId ?? "",
        estimatePropId: before?.estimatePropId ?? "",
        priorityPropId: before?.priorityPropId ?? "",
      },
    });
    const after = (await s.database(s.tasks._id))?.taskConfig;
    expect(after?.blockedByPropId).toBe(before?.blockedByPropId);
    expect(after?.parentPropId).toBe(before?.parentPropId);
    expect(after?.sprintPropId).toBe(before?.sprintPropId);
  });
});
