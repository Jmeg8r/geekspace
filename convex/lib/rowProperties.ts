import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { DateValue, PropertyDef } from "./types";
import { isNumber, isString } from "./predicates";

export const propertyValue = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.array(v.string()),
  v.object({
    start: v.number(),
    end: v.optional(v.number()),
    includeTime: v.optional(v.boolean()),
  }),
  v.null(),
);
export const propertyBag = v.record(v.string(), propertyValue);
export type PropertyValue =
  | string
  | number
  | boolean
  | string[]
  | DateValue
  | null;
export type PropertyBag = Record<string, PropertyValue>;

function stringIds(value: PropertyValue | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function validateValue(def: PropertyDef, value: PropertyValue) {
  if (["rollup", "createdTime", "updatedTime"].includes(def.type))
    throw new Error(`${def.name} is read-only`);
  if (value === null) return;
  const options = new Set((def.options ?? []).map((o) => o.id));
  let valid = false;
  switch (def.type) {
    case "title":
    case "text":
    case "url":
      valid = isString(value);
      break;
    case "number":
      valid = isNumber(value);
      break;
    case "checkbox":
      valid = value === true || value === false;
      break;
    case "select":
    case "status":
      valid = isString(value) && options.has(value);
      break;
    case "multiSelect":
      valid = Array.isArray(value) && value.every((id) => options.has(id));
      break;
    case "relation":
      valid = Array.isArray(value) && Boolean(def.relation);
      break;
    case "date":
      valid =
        value !== null &&
        !Array.isArray(value) &&
        !isString(value) &&
        !isNumber(value) &&
        value !== true &&
        value !== false &&
        isNumber(value.start) &&
        Math.abs(value.start) <= 8.64e15 &&
        (value.end === undefined ||
          (isNumber(value.end) &&
            value.end >= value.start &&
            Math.abs(value.end) <= 8.64e15));
      break;
  }
  if (!valid) throw new Error(`Invalid value for ${def.name}`);
}

/** One transactional writer for UI edits, MCP batches and row creation. */
export async function changeProperties(
  ctx: MutationCtx,
  row: Doc<"rows">,
  db: Doc<"databases">,
  changes: PropertyBag,
) {
  const defs: PropertyDef[] = db.properties;
  for (const [id, value] of Object.entries(changes)) {
    const def = defs.find((p) => p.id === id);
    if (!def) throw new Error(`Unknown property: ${id}`);
    validateValue(def, value);
    if (def.type === "relation" && value !== null) {
      for (const rawId of stringIds(value)) {
        const targetId = ctx.db.normalizeId("rows", rawId);
        const target = targetId ? await ctx.db.get(targetId) : null;
        if (!target || target.databaseId !== def.relation?.databaseId)
          throw new Error(`Invalid relation target for ${def.name}`);
      }
    }
  }
  // Apply the row first; reverse updates read fresh state, including self links.
  const properties = { ...row.properties };
  for (const [id, value] of Object.entries(changes)) {
    if (value === null) delete properties[id];
    else properties[id] = Array.isArray(value) ? [...new Set(value)] : value;
  }
  await ctx.db.patch(row._id, {
    properties,
    title: String(properties.title ?? ""),
    updatedAt: Date.now(),
  });
  for (const [id, value] of Object.entries(changes)) {
    const def = defs.find((p) => p.id === id)!;
    const reverseId = def.relation?.syncedPropId;
    if (def.type !== "relation" || !reverseId) continue;
    const oldIds = stringIds(row.properties?.[id]);
    const newIds = stringIds(value);
    for (const rawId of new Set([...oldIds, ...newIds])) {
      const targetId = ctx.db.normalizeId("rows", rawId);
      const target = targetId ? await ctx.db.get(targetId) : null;
      if (!target || target.databaseId !== def.relation?.databaseId) continue; // obsolete legacy links can be cleared
      const targetDb = await ctx.db.get(target.databaseId);
      const reverse: PropertyDef | undefined = targetDb?.properties.find(
        (p: PropertyDef) => p.id === reverseId,
      );
      if (
        reverse?.type !== "relation" ||
        reverse.relation?.databaseId !== db._id ||
        reverse.relation.syncedPropId !== id
      ) {
        throw new Error(`Broken synced relation: ${def.name}`);
      }
      const back = new Set(stringIds(target.properties?.[reverseId]));
      if (newIds.includes(rawId)) back.add(row._id);
      else back.delete(row._id);
      await ctx.db.patch(target._id, {
        properties: { ...target.properties, [reverseId]: [...back] },
        updatedAt: Date.now(),
      });
    }
  }
}

/** Deletion must also clear inbound one-way links and scheduling history. */
export async function deleteRowAndReferences(
  ctx: MutationCtx,
  rowId: Id<"rows">,
) {
  const dbs = await ctx.db.query("databases").collect();
  for (const db of dbs) {
    const relations: PropertyDef[] = db.properties.filter(
      (p: PropertyDef) => p.type === "relation",
    );
    if (!relations.length) continue;
    const rows = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", db._id))
      .collect();
    for (const row of rows) {
      if (row._id === rowId) continue;
      const properties = { ...row.properties };
      let changed = false;
      for (const def of relations) {
        const ids = stringIds(properties[def.id]);
        if (ids.includes(rowId)) {
          properties[def.id] = ids.filter((id) => id !== rowId);
          changed = true;
        }
      }
      if (changed)
        await ctx.db.patch(row._id, { properties, updatedAt: Date.now() });
    }
  }
  const blocks = await ctx.db
    .query("timeBlocks")
    .withIndex("by_task", (q) => q.eq("taskRowId", rowId))
    .collect();
  for (const block of blocks) await ctx.db.delete(block._id);
  await ctx.db.delete(rowId);
}
