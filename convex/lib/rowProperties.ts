import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { DateValue, PropertyDef } from "./types";
import { isNumber, isString } from "./predicates";

// WHAT: the one writer for row property values: validation at the boundary, both sides
// of synced relations, and clean deletes. Used by row creation, single edits and MCP
// batches. Adapted from PR #28's convex/lib/rowProperties.ts.
// See docs/changes/2026-10-15-row-integrity/.

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
  v.null()
);
export const propertyBag = v.record(v.string(), propertyValue);

export type PropertyValue = string | number | boolean | string[] | DateValue | null;
export type PropertyBag = Record<string, PropertyValue>;

// Date.prototype's documented range: anything outside it is not a date.
const MAX_EPOCH_MS = 8.64e15;
const READ_ONLY_TYPES = new Set(["rollup", "createdTime", "updatedTime"]);

export function relationIds(value: PropertyValue | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function isDateValue(value: PropertyValue): value is DateValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDate(value: PropertyValue): boolean {
  if (!isDateValue(value)) return false;
  const inRange = (n: number) => Number.isFinite(n) && Math.abs(n) <= MAX_EPOCH_MS;
  if (!inRange(value.start)) return false;
  return value.end === undefined || (inRange(value.end) && value.end >= value.start);
}

function validate(def: PropertyDef, value: PropertyValue) {
  if (READ_ONLY_TYPES.has(def.type)) throw new Error(`${def.name} is computed and read-only`);
  if (value === null) return;
  const options = new Set((def.options ?? []).map((o) => o.id));
  let ok: boolean;
  switch (def.type) {
    case "title":
    case "text":
    case "url":
      ok = isString(value);
      break;
    case "number":
      ok = isNumber(value) && Number.isFinite(value);
      break;
    case "checkbox":
      ok = value === true || value === false;
      break;
    case "select":
    case "status":
      ok = isString(value) && options.has(value);
      break;
    case "multiSelect":
      ok = Array.isArray(value) && value.every((id) => options.has(id));
      break;
    case "relation":
      ok = Array.isArray(value) && Boolean(def.relation);
      break;
    case "date":
      ok = validDate(value);
      break;
    default:
      ok = false;
  }
  if (!ok) throw new Error(`Invalid value for "${def.name}" (${def.type})`);
}

async function isTaskSourceDb(ctx: MutationCtx, rawId: string): Promise<boolean> {
  const id = ctx.db.normalizeId("databases", rawId);
  const db = id ? await ctx.db.get(id) : null;
  return Boolean(db?.isTaskSource);
}

/**
 * Validate and apply `changes` to `row`, then update the reverse side of every changed
 * synced relation. A null value clears the property. Returns whether a task-source
 * database was touched, so the caller knows to reflow the schedule.
 */
export async function changeProperties(
  ctx: MutationCtx,
  row: Doc<"rows">,
  db: Doc<"databases">,
  changes: PropertyBag
): Promise<{ touchedTaskSource: boolean }> {
  const defs: PropertyDef[] = db.properties;
  const defFor = (id: string) => {
    const def = defs.find((p) => p.id === id);
    if (!def) throw new Error(`Unknown property ${id} on "${db.name}"`);
    return def;
  };

  // 1. Validate everything before writing anything.
  for (const [id, value] of Object.entries(changes)) {
    const def = defFor(id);
    validate(def, value);
    if (def.type !== "relation") continue;
    for (const rawId of relationIds(value)) {
      const targetId = ctx.db.normalizeId("rows", rawId);
      const target = targetId ? await ctx.db.get(targetId) : null;
      if (!target || target.databaseId !== def.relation?.databaseId) {
        throw new Error(`"${def.name}" can only link to rows of its related database`);
      }
    }
  }

  // 2. The row itself.
  const before: PropertyBag = row.properties ?? {};
  const properties = { ...before };
  for (const [id, value] of Object.entries(changes)) {
    if (value === null) delete properties[id];
    else properties[id] = Array.isArray(value) ? [...new Set(value)] : value;
  }
  await ctx.db.patch(row._id, {
    properties,
    title: String(properties.title ?? ""),
    updatedAt: Date.now(),
  });

  // 3. Reverse sides, read fresh so self-links and same-database pairs see step 2.
  let touchedTaskSource = Boolean(db.isTaskSource);
  for (const [id, value] of Object.entries(changes)) {
    const def = defFor(id);
    const reverseId = def.relation?.syncedPropId;
    if (def.type !== "relation" || !def.relation || !reverseId) continue;
    if (await isTaskSourceDb(ctx, def.relation.databaseId)) touchedTaskSource = true;
    const oldIds = relationIds(before[id]);
    const newIds = relationIds(value);
    const targetDbId = ctx.db.normalizeId("databases", def.relation.databaseId);
    const targetDb = targetDbId ? await ctx.db.get(targetDbId) : null;
    const reverseDefs: PropertyDef[] = targetDb?.properties ?? [];
    const reverse = reverseDefs.find((p) => p.id === reverseId);
    if (
      reverse?.type !== "relation" ||
      reverse.relation?.databaseId !== db._id ||
      reverse.relation.syncedPropId !== id
    ) {
      // WHY not throw: older builds left half-pairs behind when one side of a
      // self-relation was deleted, and throwing would lock every edit to those rows. The
      // forward side is already written; the broken pair is named so it can be repaired.
      console.warn(
        `Synced relation "${def.name}" (${db._id}/${id}) has no matching reverse ${reverseId} ` +
          `on database ${def.relation.databaseId}; updated row ${row._id} on this side only`
      );
      continue;
    }
    for (const rawId of new Set([...oldIds, ...newIds])) {
      const targetId = ctx.db.normalizeId("rows", rawId);
      const target = targetId ? await ctx.db.get(targetId) : null;
      // An old link to a row that is gone, or moved databases, can simply be dropped.
      if (!target || target.databaseId !== def.relation.databaseId) continue;
      const targetProps: PropertyBag = target.properties ?? {};
      const back = new Set(relationIds(targetProps[reverseId]));
      if (newIds.includes(rawId)) back.add(row._id);
      else back.delete(row._id);
      await ctx.db.patch(target._id, {
        properties: { ...targetProps, [reverseId]: [...back] },
        updatedAt: Date.now(),
      });
    }
  }
  return { touchedTaskSource };
}

/**
 * Delete a row after removing its id from every relation that points at it and deleting
 * its time blocks. Returns whether a task-source database was touched.
 */
export async function deleteRowAndReferences(
  ctx: MutationCtx,
  rowId: Id<"rows">
): Promise<{ touchedTaskSource: boolean }> {
  const row = await ctx.db.get(rowId);
  if (!row) return { touchedTaskSource: false };
  let touchedTaskSource = false;
  const dbs = await ctx.db.query("databases").collect();
  for (const db of dbs) {
    const defs: PropertyDef[] = db.properties;
    // Only relations that can hold ids of the deleted row's database.
    const pointing = defs.filter(
      (p) => p.type === "relation" && p.relation?.databaseId === row.databaseId
    );
    if (pointing.length === 0) continue;
    const rows = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", db._id))
      .collect();
    for (const other of rows) {
      if (other._id === rowId) continue;
      const props: PropertyBag = other.properties ?? {};
      let changed = false;
      const next = { ...props };
      for (const def of pointing) {
        const current = relationIds(props[def.id]);
        if (current.includes(rowId)) {
          next[def.id] = current.filter((id) => id !== rowId);
          changed = true;
        }
      }
      if (changed) {
        await ctx.db.patch(other._id, { properties: next, updatedAt: Date.now() });
        if (db.isTaskSource) touchedTaskSource = true;
      }
    }
  }
  const blocks = await ctx.db
    .query("timeBlocks")
    .withIndex("by_task", (q) => q.eq("taskRowId", rowId))
    .collect();
  for (const block of blocks) await ctx.db.delete(block._id);
  const home = await ctx.db.get(row.databaseId);
  if (home?.isTaskSource) touchedTaskSource = true;
  await ctx.db.delete(rowId);
  return { touchedTaskSource };
}
