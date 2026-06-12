import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { makeId, type PropertyDef, type SelectOption } from "./lib/types";

// WHAT: Page tree CRUD. Pages are docs or database containers; trash works on
// subtree roots — children of a trashed page become unreachable in the tree
// (they only render under their parent) and return when the root is restored.

export const list = query({
  args: {},
  handler: async (ctx) => {
    const pages = await ctx.db.query("pages").collect();
    return pages.filter((p) => !p.trashed);
  },
});

export const listTrashed = query({
  args: {},
  handler: async (ctx) => {
    const pages = await ctx.db.query("pages").collect();
    return pages.filter((p) => p.trashed);
  },
});

export const get = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => ctx.db.get(args.pageId),
});

export function defaultDatabaseProperties(): PropertyDef[] {
  const statusOptions: SelectOption[] = [
    { id: makeId(), name: "Not started", color: "gray", group: "todo" },
    { id: makeId(), name: "In progress", color: "blue", group: "inprogress" },
    { id: makeId(), name: "Done", color: "green", group: "complete" },
  ];
  return [
    { id: "title", name: "Name", type: "title" },
    { id: makeId(), name: "Status", type: "status", options: statusOptions },
    { id: makeId(), name: "Date", type: "date" },
    { id: makeId(), name: "Tags", type: "multiSelect", options: [] },
  ];
}

export async function createPageHelper(
  ctx: MutationCtx,
  args: { title?: string; kind: "doc" | "database"; parentId?: Id<"pages">; icon?: string }
) {
  const now = Date.now();
  let databaseId: Id<"databases"> | undefined;
  if (args.kind === "database") {
    databaseId = await ctx.db.insert("databases", {
      name: args.title ?? "",
      properties: defaultDatabaseProperties(),
    });
    await ctx.db.insert("views", {
      databaseId,
      name: "Table",
      type: "table",
      order: 0,
    });
  }
  const pageId = await ctx.db.insert("pages", {
    title: args.title ?? "",
    icon: args.icon,
    kind: args.kind,
    parentId: args.parentId,
    databaseId,
    favorite: false,
    trashed: false,
    order: now,
    updatedAt: now,
  });
  if (databaseId) await ctx.db.patch(databaseId, { pageId });
  return pageId;
}

export const create = mutation({
  args: {
    title: v.optional(v.string()),
    kind: v.union(v.literal("doc"), v.literal("database")),
    parentId: v.optional(v.id("pages")),
    icon: v.optional(v.string()),
  },
  handler: async (ctx, args) => createPageHelper(ctx, args),
});

export const update = mutation({
  args: {
    pageId: v.id("pages"),
    title: v.optional(v.string()),
    icon: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) return;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.title !== undefined) patch.title = args.title;
    if (args.icon !== undefined) patch.icon = args.icon === "" ? undefined : args.icon;
    await ctx.db.patch(args.pageId, patch);
    // WHY: a database page's title doubles as the database name (relation labels).
    if (args.title !== undefined && page.databaseId) {
      await ctx.db.patch(page.databaseId, { name: args.title });
    }
  },
});

export const setContent = mutation({
  args: { pageId: v.id("pages"), content: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.pageId, { content: args.content, updatedAt: Date.now() });
  },
});

export const toggleFavorite = mutation({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) return;
    await ctx.db.patch(args.pageId, { favorite: !page.favorite });
  },
});

export const trash = mutation({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.pageId, { trashed: true, favorite: false });
  },
});

export const restore = mutation({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) return;
    // WHY: if the original parent is gone or trashed, restore to the root so the
    // page doesn't come back unreachable.
    let parentId = page.parentId;
    if (parentId) {
      const parent = await ctx.db.get(parentId);
      if (!parent || parent.trashed) parentId = undefined;
    }
    await ctx.db.patch(args.pageId, { trashed: false, parentId });
  },
});

// WHAT: Move a page in the tree — reparent and/or reorder. The destination
// level is reindexed to clean sequential `order` values (sibling counts are
// small, so this is simpler and drift-free vs. fractional ordering).
export const move = mutation({
  args: {
    pageId: v.id("pages"),
    // undefined newParentId means "move to the top level" (a root page).
    newParentId: v.optional(v.id("pages")),
    index: v.number(), // target position among the destination's children
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) return;
    const newParentId = args.newParentId;

    // Guard: a page can't be moved into itself or any of its descendants —
    // that would orphan a subtree into an unreachable cycle.
    if (newParentId) {
      let cursor: Id<"pages"> | undefined = newParentId;
      while (cursor) {
        if (cursor === args.pageId) return "cycle";
        const node: Doc<"pages"> | null = await ctx.db.get(cursor);
        cursor = node?.parentId;
      }
    }

    // Destination siblings: same parent, non-trashed, excluding the moved page.
    const all = await ctx.db.query("pages").collect();
    const siblings = all
      .filter((p) => !p.trashed && p._id !== args.pageId && p.parentId === newParentId)
      .sort((a, b) => a.order - b.order);

    const idx = Math.max(0, Math.min(args.index, siblings.length));
    siblings.splice(idx, 0, page);

    const now = Date.now();
    await Promise.all(
      siblings.map((p, i) => {
        if (p._id === args.pageId) {
          return ctx.db.patch(p._id, { parentId: newParentId, order: i, updatedAt: now });
        }
        // Skip no-op writes to keep the mutation cheap.
        return p.order === i ? Promise.resolve() : ctx.db.patch(p._id, { order: i });
      })
    );
  },
});

async function deletePageDeep(ctx: MutationCtx, pageId: Id<"pages">) {
  const children = await ctx.db
    .query("pages")
    .withIndex("by_parent", (q) => q.eq("parentId", pageId))
    .collect();
  for (const child of children) await deletePageDeep(ctx, child._id);

  const page = await ctx.db.get(pageId);
  if (!page) return;
  if (page.databaseId) {
    const rows = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", page.databaseId!))
      .collect();
    for (const row of rows) {
      const blocks = await ctx.db
        .query("timeBlocks")
        .withIndex("by_task", (q) => q.eq("taskRowId", row._id))
        .collect();
      for (const b of blocks) await ctx.db.delete(b._id);
      await ctx.db.delete(row._id);
    }
    const views = await ctx.db
      .query("views")
      .withIndex("by_database", (q) => q.eq("databaseId", page.databaseId!))
      .collect();
    for (const view of views) await ctx.db.delete(view._id);
    await ctx.db.delete(page.databaseId);
  }
  await ctx.db.delete(pageId);
}

export const deleteForever = mutation({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    await deletePageDeep(ctx, args.pageId);
  },
});
