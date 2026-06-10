import { query } from "./_generated/server";
import { v } from "convex/values";

// WHAT: Cross-workspace search for the command palette — pages and database rows.

export const searchAll = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim();
    if (!q) return { pages: [], rows: [] };

    const pages = (
      await ctx.db
        .query("pages")
        .withSearchIndex("search_title", (s) => s.search("title", q))
        .take(10)
    ).filter((p) => !p.trashed);

    const rowDocs = await ctx.db
      .query("rows")
      .withSearchIndex("search_title", (s) => s.search("title", q))
      .take(10);

    const rows = [];
    for (const row of rowDocs) {
      const db = await ctx.db.get(row.databaseId);
      if (!db?.pageId) continue;
      const page = await ctx.db.get(db.pageId);
      if (!page || page.trashed) continue;
      rows.push({
        _id: row._id,
        title: row.title,
        databaseId: row.databaseId,
        databaseName: db.name || "Untitled",
        pageId: db.pageId,
        pageIcon: page.icon,
      });
    }
    const docs = (
      await ctx.db
        .query("docs")
        .withSearchIndex("search_name", (s) => s.search("name", q))
        .take(6)
    ).filter((d) => !d.trashed);

    return {
      pages: pages.map((p) => ({
        _id: p._id,
        title: p.title,
        icon: p.icon,
        kind: p.kind,
      })),
      rows,
      docs: docs.map((d) => ({ _id: d._id, name: d.name, mime: d.mime })),
    };
  },
});
