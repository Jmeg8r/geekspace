import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// WHAT: pages.list is the page tree the sidebar, Home and MCP read. It must hide every
// page under a trashed ancestor and must not carry page bodies.
// WHY: trash marks only the root, so its subpages leaked into Favorites, Recently edited
// and MCP's page tree; and every autosave re-sent every page's content to all of them.
// See docs/changes/2026-10-15-editor-saves/.

const modules = import.meta.glob("../convex/**/*.ts");

async function tree() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const base = { kind: "doc" as const, trashed: false, updatedAt: 1, content: "[]" };
    const root = await ctx.db.insert("pages", { ...base, title: "Root", favorite: false, order: 0 });
    const child = await ctx.db.insert("pages", {
      ...base,
      title: "Child",
      parentId: root,
      favorite: true,
      order: 1,
    });
    const grandchild = await ctx.db.insert("pages", {
      ...base,
      title: "Grandchild",
      parentId: child,
      favorite: false,
      order: 2,
    });
    const other = await ctx.db.insert("pages", { ...base, title: "Other", favorite: false, order: 3 });
    return { root, child, grandchild, other };
  });
  return { t, ids };
}

describe("pages.list", () => {
  it("does not return page bodies", async () => {
    const { t } = await tree();
    const pages = await t.query(api.pages.list, {});
    expect(pages.length).toBe(4);
    for (const p of pages) expect(p).not.toHaveProperty("content");
  });

  it("hides every page under a trashed ancestor, and restores them with it", async () => {
    const { t, ids } = await tree();
    await t.mutation(api.pages.trash, { pageId: ids.root });
    const titles = (await t.query(api.pages.list, {})).map((p) => p.title);
    expect(titles).toEqual(["Other"]);

    await t.mutation(api.pages.restore, { pageId: ids.root });
    const restored = await t.query(api.pages.list, {});
    expect(restored.map((p) => p.title).sort()).toEqual(["Child", "Grandchild", "Other", "Root"]);
    expect(restored.find((p) => p.title === "Child")?.favorite).toBe(true);
  });
});
