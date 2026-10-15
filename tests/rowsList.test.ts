import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// WHAT: rows.list feeds every database view and must not carry row page bodies; relation
// pickers and filters only need titles. See docs/changes/2026-10-15-database-ui/.

const modules = import.meta.glob("../convex/**/*.ts");

async function seededTasks() {
  const t = convexTest(schema, modules);
  await t.mutation(api.seed.seedWorkspace, {});
  const dbs = await t.run((ctx) => ctx.db.query("databases").collect());
  const tasks = dbs.find((d) => d.isTaskSource);
  const projects = dbs.find((d) => d.name === "Projects");
  if (!tasks || !projects) throw new Error("seed did not create Tasks and Projects");
  // Give one task a page body, so its absence from the list is meaningful.
  const first = await t.run((ctx) =>
    ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", tasks._id))
      .first()
  );
  if (!first) throw new Error("no tasks");
  await t.mutation(api.rows.setContent, { rowId: first._id, content: '[{"type":"paragraph"}]' });
  return { t, tasks, projects };
}

describe("rows.list", () => {
  it("does not return row page bodies", async () => {
    const { t, tasks } = await seededTasks();
    const { rows } = await t.query(api.rows.list, { databaseId: tasks._id });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty("content");
  });

  it("still resolves relation titles and rollups", async () => {
    const { t, projects } = await seededTasks();
    const { rows, relationTitles } = await t.query(api.rows.list, { databaseId: projects._id });
    expect(Object.keys(relationTitles).length).toBeGreaterThan(0);
    const launch = rows.find((r) => r.title === "Geekspace Launch");
    // One of its four seeded tasks is Done: the Progress rollup reads 25%.
    expect(Object.values(launch?.computed ?? {})).toContain(25);
  });
});

describe("rows.listTitles", () => {
  it("returns only ids and titles, in row order", async () => {
    const { t, tasks } = await seededTasks();
    const titles = await t.query(api.rows.listTitles, { databaseId: tasks._id });
    expect(titles.length).toBeGreaterThan(0);
    for (const entry of titles) expect(Object.keys(entry).sort()).toEqual(["_id", "title"]);
  });
});
