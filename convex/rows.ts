import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { PropertyDef } from "./lib/types";
import { runReflow } from "./scheduling";

// WHAT: Database rows — every row is also a page (it can hold BlockNote content).
// Rollups are computed server-side at read time; relation titles ship alongside
// rows so cells never need per-chip queries.

type EnrichedRow = Doc<"rows"> & { computed: Record<string, number | null> };

async function enrichRows(
  ctx: QueryCtx,
  db: Doc<"databases">,
  rows: Doc<"rows">[]
): Promise<{ rows: EnrichedRow[]; relationTitles: Record<string, string> }> {
  const props = db.properties as PropertyDef[];
  const relationProps = props.filter((p) => p.type === "relation");
  const rollupProps = props.filter((p) => p.type === "rollup" && p.rollup);

  // Collect every referenced row id once.
  const refIds = new Set<string>();
  for (const row of rows) {
    for (const rp of relationProps) {
      const ids = (row.properties?.[rp.id] ?? []) as string[];
      for (const id of ids) refIds.add(id);
    }
  }
  const refDocs = new Map<string, Doc<"rows">>();
  for (const id of refIds) {
    const doc = await ctx.db.get(id as Id<"rows">);
    if (doc) refDocs.set(id, doc);
  }
  const relationTitles: Record<string, string> = {};
  for (const [id, doc] of refDocs) relationTitles[id] = doc.title || "Untitled";

  // Target dbs for percentComplete rollups (status groups live on the prop def).
  const targetDbCache = new Map<string, Doc<"databases"> | null>();
  async function getTargetDb(databaseId: string) {
    if (!targetDbCache.has(databaseId)) {
      targetDbCache.set(databaseId, await ctx.db.get(databaseId as Id<"databases">));
    }
    return targetDbCache.get(databaseId) ?? null;
  }

  const enriched: EnrichedRow[] = [];
  for (const row of rows) {
    const computed: Record<string, number | null> = {};
    for (const rp of rollupProps) {
      const cfg = rp.rollup!;
      const relProp = props.find((p) => p.id === cfg.relationPropId);
      if (!relProp?.relation) {
        computed[rp.id] = null;
        continue;
      }
      const ids = ((row.properties?.[relProp.id] ?? []) as string[]).filter((id) =>
        refDocs.has(id)
      );
      const targets = ids.map((id) => refDocs.get(id)!);
      const values = targets.map((t) => t.properties?.[cfg.targetPropId]);
      switch (cfg.aggregate) {
        case "count":
          computed[rp.id] = targets.length;
          break;
        case "countValues":
          computed[rp.id] = values.filter(
            (x) => x !== undefined && x !== null && x !== "" && !(Array.isArray(x) && x.length === 0)
          ).length;
          break;
        case "sum":
        case "average":
        case "min":
        case "max": {
          const nums = values.filter((x): x is number => typeof x === "number");
          if (nums.length === 0) {
            computed[rp.id] = cfg.aggregate === "sum" ? 0 : null;
            break;
          }
          const sum = nums.reduce((a, b) => a + b, 0);
          computed[rp.id] =
            cfg.aggregate === "sum"
              ? sum
              : cfg.aggregate === "average"
                ? Math.round((sum / nums.length) * 10) / 10
                : cfg.aggregate === "min"
                  ? Math.min(...nums)
                  : Math.max(...nums);
          break;
        }
        case "percentComplete": {
          const targetDb = await getTargetDb(relProp.relation.databaseId);
          const targetProp = (targetDb?.properties as PropertyDef[] | undefined)?.find(
            (p) => p.id === cfg.targetPropId
          );
          const completeIds = new Set(
            (targetProp?.options ?? [])
              .filter((o) => o.group === "complete")
              .map((o) => o.id)
          );
          computed[rp.id] =
            targets.length === 0
              ? 0
              : Math.round(
                  (100 * values.filter((x) => typeof x === "string" && completeIds.has(x)).length) /
                    targets.length
                );
          break;
        }
      }
    }
    enriched.push({ ...row, computed });
  }
  return { rows: enriched, relationTitles };
}

export const list = query({
  args: { databaseId: v.id("databases") },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return { rows: [], relationTitles: {} };
    const rows = await ctx.db
      .query("rows")
      .withIndex("by_database", (q) => q.eq("databaseId", args.databaseId))
      .collect();
    rows.sort((a, b) => a.order - b.order);
    return enrichRows(ctx, db, rows);
  },
});

export const get = query({
  args: { rowId: v.id("rows") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) return null;
    const db = await ctx.db.get(row.databaseId);
    if (!db) return null;
    const { rows, relationTitles } = await enrichRows(ctx, db, [row]);
    return { row: rows[0], database: db, relationTitles };
  },
});

async function reflowIfTaskSource(
  ctx: MutationCtx,
  db: Doc<"databases"> | null,
  tzOffsetMin?: number
) {
  if (db?.isTaskSource) await runReflow(ctx, tzOffsetMin);
}

export const create = mutation({
  args: {
    databaseId: v.id("databases"),
    properties: v.optional(v.any()),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const db = await ctx.db.get(args.databaseId);
    if (!db) return null;
    const properties = args.properties ?? {};
    const now = Date.now();
    const rowId = await ctx.db.insert("rows", {
      databaseId: args.databaseId,
      title: String(properties.title ?? ""),
      properties,
      order: now,
      updatedAt: now,
    });
    await reflowIfTaskSource(ctx, db, args.tzOffsetMin);
    return rowId;
  },
});

export const updateProperty = mutation({
  args: {
    rowId: v.id("rows"),
    propId: v.string(),
    value: v.optional(v.any()),
    tzOffsetMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) return;
    const db = await ctx.db.get(row.databaseId);
    if (!db) return;
    const props = db.properties as PropertyDef[];
    const def = props.find((p) => p.id === args.propId);
    if (!def) return;

    const oldProperties = (row.properties ?? {}) as Record<string, unknown>;
    const newProperties = { ...oldProperties };
    if (args.value === undefined || args.value === null) {
      delete newProperties[args.propId];
    } else {
      newProperties[args.propId] = args.value;
    }

    const patch: Record<string, unknown> = {
      properties: newProperties,
      updatedAt: Date.now(),
    };
    if (args.propId === "title") patch.title = String(args.value ?? "");
    await ctx.db.patch(args.rowId, patch);

    // Two-way relation sync (Notion-style synced properties).
    if (def.type === "relation" && def.relation?.syncedPropId) {
      const syncedId = def.relation.syncedPropId;
      const newIds = (args.value ?? []) as string[];
      const oldIds = (oldProperties[args.propId] ?? []) as string[];
      const added = newIds.filter((x) => !oldIds.includes(x));
      const removed = oldIds.filter((x) => !newIds.includes(x));
      for (const id of added) {
        const target = await ctx.db.get(id as Id<"rows">);
        if (!target) continue;
        const arr = ((target.properties?.[syncedId] ?? []) as string[]).slice();
        if (!arr.includes(args.rowId)) {
          arr.push(args.rowId);
          await ctx.db.patch(target._id, {
            properties: { ...(target.properties ?? {}), [syncedId]: arr },
          });
        }
      }
      for (const id of removed) {
        const target = await ctx.db.get(id as Id<"rows">);
        if (!target) continue;
        const arr = ((target.properties?.[syncedId] ?? []) as string[]).filter(
          (x) => x !== args.rowId
        );
        await ctx.db.patch(target._id, {
          properties: { ...(target.properties ?? {}), [syncedId]: arr },
        });
      }
    }

    await reflowIfTaskSource(ctx, db, args.tzOffsetMin);
  },
});

export const setContent = mutation({
  args: { rowId: v.id("rows"), content: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.rowId, { content: args.content, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { rowId: v.id("rows"), tzOffsetMin: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) return;
    const db = await ctx.db.get(row.databaseId);
    const blocks = await ctx.db
      .query("timeBlocks")
      .withIndex("by_task", (q) => q.eq("taskRowId", args.rowId))
      .collect();
    for (const b of blocks) await ctx.db.delete(b._id);
    await ctx.db.delete(args.rowId);
    await reflowIfTaskSource(ctx, db, args.tzOffsetMin);
  },
});
