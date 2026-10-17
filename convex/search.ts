import { query } from "./_generated/server";
import { v } from "convex/values";
import { isPageHidden } from "./lib/pageTree";

// WHAT: Cross-workspace search for the command palette — pages, database rows and docs.

const PAGE_RESULTS = 10;
const ROW_RESULTS = 10;
const DOC_RESULTS = 6;
// WHY a candidate pool: hidden items (trashed, or under a trashed page) must be dropped
// BEFORE the result counts are applied, or they crowd live matches out. Bounded because
// this runs on every keystroke; more than this many hidden items outranking a live one is
// not a realistic workspace. See docs/changes/2026-10-17-docs-search/.
const SEARCH_CANDIDATES = 50;

export const searchAll = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim();
    if (!q) return { pages: [], rows: [], docs: [] };

    const pageHits = await ctx.db
      .query("pages")
      .withSearchIndex("search_title", (s) => s.search("title", q))
      .take(SEARCH_CANDIDATES);
    const pages = [];
    for (const p of pageHits) {
      if (pages.length >= PAGE_RESULTS) break;
      if (!(await isPageHidden(ctx.db, p._id))) pages.push(p);
    }

    const rowDocs = await ctx.db
      .query("rows")
      .withSearchIndex("search_title", (s) => s.search("title", q))
      .take(SEARCH_CANDIDATES);
    const rows = [];
    for (const row of rowDocs) {
      if (rows.length >= ROW_RESULTS) break;
      const db = await ctx.db.get(row.databaseId);
      if (!db?.pageId || (await isPageHidden(ctx.db, db.pageId))) continue;
      const page = await ctx.db.get(db.pageId);
      if (!page) continue;
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
        .take(SEARCH_CANDIDATES)
    )
      .filter((d) => !d.trashed)
      .slice(0, DOC_RESULTS);

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
