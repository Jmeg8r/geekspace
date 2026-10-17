import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// WHAT: the docs viewer reads a doc live, and an upload whose record failed to save can
// be discarded without risking a file something still uses. See docs/changes/2026-10-17-docs-search/.

const modules = import.meta.glob("../convex/**/*.ts");

describe("docs.get", () => {
  it("returns the live doc with its URL, then null once deleted", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["hello"])));
    const docId = await t.mutation(api.docs.add, { name: "a.txt", storageId, mime: "text/plain", size: 5 });
    await t.mutation(api.docs.rename, { docId, name: "renamed.txt" });
    const live = await t.query(api.docs.get, { docId });
    expect(live?.name).toBe("renamed.txt");
    expect(typeof live?.url).toBe("string");
    await t.mutation(api.docs.remove, { docId });
    expect(await t.query(api.docs.get, { docId })).toBeNull();
  });
});

describe("files.discardUnattached", () => {
  it("deletes an upload nothing references", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["orphan"])));
    expect(await t.mutation(api.files.discardUnattached, { storageId })).toBe(true);
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).toBeNull();
  });

  it("refuses to delete a file a doc still uses", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["kept"])));
    await t.mutation(api.docs.add, { name: "kept.txt", storageId, mime: "text/plain", size: 4 });
    expect(await t.mutation(api.files.discardUnattached, { storageId })).toBe(false);
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
  });

  it("refuses to delete a meeting's audio", async () => {
    const t = convexTest(schema, modules);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["audio"])));
    await t.run((ctx) =>
      ctx.db.insert("meetings", { title: "m", status: "done", startedAt: 0, audioStorageId: storageId })
    );
    expect(await t.mutation(api.files.discardUnattached, { storageId })).toBe(false);
    expect(await t.run((ctx) => ctx.storage.getUrl(storageId))).not.toBeNull();
  });
});
