import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// WHAT: Docs library — files in Convex storage with metadata, viewable in-app.

export const list = query({
  args: { projectRowId: v.optional(v.id("rows")) },
  handler: async (ctx, args) => {
    const docs = args.projectRowId
      ? await ctx.db
          .query("docs")
          .withIndex("by_project", (q) => q.eq("projectRowId", args.projectRowId))
          .collect()
      : await ctx.db.query("docs").collect();
    const visible = docs.filter((d) => !d.trashed);
    visible.sort((a, b) => b._creationTime - a._creationTime);
    const out = [];
    for (const d of visible) {
      out.push({ ...d, url: await ctx.storage.getUrl(d.storageId) });
    }
    return out;
  },
});

export const add = mutation({
  args: {
    name: v.string(),
    storageId: v.id("_storage"),
    mime: v.string(),
    size: v.number(),
    projectRowId: v.optional(v.id("rows")),
  },
  handler: async (ctx, args) => ctx.db.insert("docs", args),
});

export const rename = mutation({
  args: { docId: v.id("docs"), name: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.docId, { name: args.name });
  },
});

export const setProject = mutation({
  args: { docId: v.id("docs"), projectRowId: v.optional(v.id("rows")) },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.docId, { projectRowId: args.projectRowId });
  },
});

export const remove = mutation({
  args: { docId: v.id("docs") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.docId);
    if (!doc) return;
    // Hard delete: reclaim storage too — docs aren't workspace content like pages.
    await ctx.storage.delete(doc.storageId);
    await ctx.db.delete(args.docId);
  },
});
