import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { PropertyDef } from "../convex/lib/types";

// WHAT: a fresh workspace, seeded once, must carry the whole project-management setup
// the README and User Guide describe — not only Projects and Tasks.
// WHY: the PM pieces used to come only from pm:applyPmUpgrade, which nothing called, so
// `npm run seed` and every packaged install shipped without them.
// See docs/changes/2026-10-14-first-run-pm-setup/.

const modules = import.meta.glob("../convex/**/*.ts");

async function readSeededWorkspace(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const databases = await ctx.db.query("databases").collect();
    const views = await ctx.db.query("views").collect();
    const pages = await ctx.db.query("pages").collect();
    const templates = await ctx.db.query("templates").collect();
    const rows = await ctx.db.query("rows").collect();
    const tasks = databases.find((d) => d.isTaskSource);
    // `properties` is stored schemaless (v.any()); the annotation only names the expected type.
    const taskProps: PropertyDef[] = tasks?.properties ?? [];
    return {
      sprintsDbs: databases.filter((d) => d.sprintConfig).length,
      taskPropNames: taskProps.map((p) => p.name),
      viewNames: views.map((v) => v.name),
      userGuides: pages.filter((p) => p.title === "User Guide" && !p.trashed).length,
      templates: templates.length,
      counts: {
        databases: databases.length,
        views: views.length,
        pages: pages.length,
        templates: templates.length,
        rows: rows.length,
      },
    };
  });
}

describe("seedWorkspace on an empty database", () => {
  it("creates the full project-management setup", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.seed.seedWorkspace, {});
    const seeded = await readSeededWorkspace(t);

    expect(seeded.sprintsDbs).toBe(1);
    expect(seeded.taskPropNames).toEqual(expect.arrayContaining(["Blocked by", "Parent task"]));
    expect(seeded.viewNames).toEqual(expect.arrayContaining(["Sprint Board", "Backlog"]));
    expect(seeded.userGuides).toBe(1);
    expect(seeded.templates).toBeGreaterThanOrEqual(3);
  });

  it("leaves nothing for a later pm:applyPmUpgrade to do", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.seed.seedWorkspace, {});
    expect(await t.mutation(api.pm.applyPmUpgrade, {})).toBe("already-up-to-date");
  });

  it("changes nothing when run a second time", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.seed.seedWorkspace, {});
    const before = await readSeededWorkspace(t);
    expect(await t.mutation(api.seed.seedWorkspace, {})).toBe("already-seeded");
    expect((await readSeededWorkspace(t)).counts).toEqual(before.counts);
  });
});
