import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { PropertyDef } from "./lib/types";

// WHAT: Project-tag helpers. A "project" is a row in the Projects database —
// whichever database the Tasks database's "Project" relation points at (with a
// fallback to a database literally named "Projects"). Used by the page
// project-tag picker so pages and tasks share one source of truth.
export async function resolveProjectsDb(ctx: QueryCtx): Promise<Doc<"databases"> | null> {
  const dbs = await ctx.db.query("databases").collect();
  const tasksDb = dbs.find((d) => d.isTaskSource);
  if (tasksDb) {
    const props = tasksDb.properties as PropertyDef[];
    const rel = props.find((p) => p.type === "relation" && p.name.toLowerCase() === "project");
    const targetId = rel?.relation?.databaseId;
    if (targetId) {
      const target = dbs.find((d) => d._id === (targetId as Id<"databases">));
      if (target) return target;
    }
  }
  return dbs.find((d) => d.name.toLowerCase() === "projects") ?? null;
}

/** Projects available to tag a page with — id + display title, in row order. */
export const listForPicker = query({
  args: {},
  handler: async (ctx) => {
    const db = await resolveProjectsDb(ctx);
    if (!db) return [];
    const rows = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", db._id))
      .collect();
    return rows
      .sort((a, b) => a.order - b.order)
      .map((r) => ({ rowId: r._id, title: r.title || "Untitled" }));
  },
});
