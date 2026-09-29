import { describe, it, expect } from "vitest";
import { getPageByAnyId } from "../convex/lib/pageLookup";

// A fake database that behaves like Convex where it matters here: `get` resolves an id
// from ANY table (so an `events` id would hand back an events document), and it throws on
// a string that is not shaped like an id, as the real one does.
const PAGE = { _id: "pages:1", title: "A page", kind: "doc" };
const EVENT = { _id: "events:1", title: "An event" };
const STORE = new Map<string, object>([
  ["pages:1", PAGE],
  ["events:1", EVENT],
]);

function fakeDb() {
  const normalizeIdCalls: Array<[string, string]> = [];
  const getCalls: string[] = [];
  const db = {
    normalizeId(table: string, id: string) {
      normalizeIdCalls.push([table, id]);
      return id.startsWith(`${table}:`) ? id : null;
    },
    async get(id: string) {
      getCalls.push(id);
      if (!/^[a-z]+:\d+$/.test(id)) throw new Error(`Invalid argument id: ${id}`);
      return STORE.get(id) ?? null;
    },
  };
  // SAFETY: the fake implements only the two members getPageByAnyId calls, and its ids are
  // plain strings. Nothing in these tests depends on the branded Id type or the Doc shape.
  return { db: db as Parameters<typeof getPageByAnyId>[0], normalizeIdCalls, getCalls };
}

describe("getPageByAnyId", () => {
  it("returns the page for a valid pages id", async () => {
    const { db } = fakeDb();
    await expect(getPageByAnyId(db, "pages:1")).resolves.toEqual(PAGE);
  });

  it("returns null for a valid pages id whose page was deleted", async () => {
    const { db } = fakeDb();
    await expect(getPageByAnyId(db, "pages:2")).resolves.toBeNull();
  });

  it("returns null for an id from another table, without reading it", async () => {
    const { db, getCalls } = fakeDb();
    await expect(getPageByAnyId(db, "events:1")).resolves.toBeNull();
    expect(getCalls).toEqual([]);
  });

  it.each(["not-an-id", ""])("returns null for the malformed id %j, without reading it", async (bad) => {
    const { db, getCalls } = fakeDb();
    await expect(getPageByAnyId(db, bad)).resolves.toBeNull();
    expect(getCalls).toEqual([]);
  });

  it("asks normalizeId about the pages table", async () => {
    const { db, normalizeIdCalls } = fakeDb();
    await getPageByAnyId(db, "pages:1");
    expect(normalizeIdCalls).toEqual([["pages", "pages:1"]]);
  });
});
