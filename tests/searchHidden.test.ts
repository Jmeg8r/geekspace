import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// WHAT: command-palette search never shows hidden items and never lets them crowd out
// live ones. See docs/changes/2026-10-17-docs-search/.

const modules = import.meta.glob("../convex/**/*.ts");
type T = ReturnType<typeof convexTest>;

const page = (t: T, title: string, fields: { trashed?: boolean; parentId?: Id<"pages"> } = {}) =>
  t.run((ctx) =>
    ctx.db.insert("pages", {
      title,
      kind: "doc",
      favorite: false,
      trashed: fields.trashed ?? false,
      parentId: fields.parentId,
      order: 0,
      updatedAt: 0,
    })
  );

const blob = (t: T) => t.run((ctx) => ctx.storage.store(new Blob(["x"])));

describe("search.searchAll", () => {
  it("finds the live page even when trashed matches outrank it", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 12; i++) await page(t, `Roadmap draft ${i}`, { trashed: true });
    await page(t, "Roadmap");
    const result = await t.query(api.search.searchAll, { q: "Roadmap" });
    expect(result.pages.map((p) => p.title)).toEqual(["Roadmap"]);
  });

  it("hides a page whose parent is trashed", async () => {
    const t = convexTest(schema, modules);
    const parent = await page(t, "Archive", { trashed: true });
    await page(t, "Quarterly plan", { parentId: parent });
    const result = await t.query(api.search.searchAll, { q: "Quarterly" });
    expect(result.pages).toEqual([]);
  });

  it("hides rows of a database that lives under a trashed page", async () => {
    const t = convexTest(schema, modules);
    const parent = await page(t, "Old stuff", { trashed: true });
    const dbPage = await page(t, "Old tasks", { parentId: parent });
    const databaseId = await t.run((ctx) => ctx.db.insert("databases", { name: "Old tasks", pageId: dbPage, properties: [] }));
    await t.run((ctx) =>
      ctx.db.insert("rows", { databaseId, title: "Migrate server", properties: {}, order: 0, updatedAt: 0 })
    );
    const result = await t.query(api.search.searchAll, { q: "Migrate" });
    expect(result.rows).toEqual([]);
  });

  it("finds the live doc even when trashed docs outrank it", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 8; i++) {
      const storageId = await blob(t);
      await t.run((ctx) => ctx.db.insert("docs", { name: `invoice old ${i}.pdf`, storageId, mime: "application/pdf", size: 1, trashed: true }));
    }
    const storageId = await blob(t);
    await t.run((ctx) => ctx.db.insert("docs", { name: "invoice.pdf", storageId, mime: "application/pdf", size: 1 }));
    const result = await t.query(api.search.searchAll, { q: "invoice" });
    expect(result.docs.map((d) => d.name)).toEqual(["invoice.pdf"]);
  });

  it("returns the same shape for an empty query", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.search.searchAll, { q: "  " })).toEqual({ pages: [], rows: [], docs: [] });
  });
});
