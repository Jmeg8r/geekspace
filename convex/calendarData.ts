import { query } from "./_generated/server";
import type { DateValue, PropertyDef } from "./lib/types";

// WHAT: Read models for the calendar + home dashboard — database rows with
// dates (Notion Calendar-style "connected databases") and the cross-database
// "My Tasks" feed.

export const listForCalendar = query({
  args: {},
  handler: async (ctx) => {
    const dbs = await ctx.db.query("databases").collect();
    const out: Array<{
      rowId: string;
      title: string;
      date: DateValue;
      color: string;
      databaseId: string;
      done: boolean;
    }> = [];
    for (const db of dbs) {
      if (!db.showOnCalendar || !db.calendarDatePropId) continue;
      const props = db.properties as PropertyDef[];
      const statusPropId =
        db.taskConfig?.statusPropId ?? props.find((p) => p.type === "status")?.id;
      const statusProp = props.find((p) => p.id === statusPropId);
      const rows = await ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", db._id))
        .collect();
      for (const row of rows) {
        const date = row.properties?.[db.calendarDatePropId] as DateValue | undefined;
        if (!date || typeof date.start !== "number") continue;
        const statusVal = statusPropId ? row.properties?.[statusPropId] : undefined;
        const done =
          statusProp?.options?.find((o) => o.id === statusVal)?.group === "complete";
        out.push({
          rowId: row._id,
          title: row.title || "Untitled",
          date,
          color: db.color ?? "orange",
          databaseId: db._id,
          done,
        });
      }
    }
    return out;
  },
});

export const myTasks = query({
  args: {},
  handler: async (ctx) => {
    const dbs = await ctx.db.query("databases").collect();
    const out: Array<{
      rowId: string;
      title: string;
      due?: DateValue;
      estimateMin?: number;
      priorityName?: string;
      priorityColor?: string;
      inProgress: boolean;
      statusPropId: string;
      completeOptionId?: string;
      databaseId: string;
    }> = [];
    for (const db of dbs) {
      if (!db.isTaskSource || !db.taskConfig) continue;
      const props = db.properties as PropertyDef[];
      const statusProp = props.find((p) => p.id === db.taskConfig!.statusPropId);
      const priorityProp = props.find((p) => p.id === db.taskConfig!.priorityPropId);
      const completeOption = statusProp?.options?.find((o) => o.group === "complete");
      const rows = await ctx.db
        .query("rows")
        .withIndex("by_database", (q) => q.eq("databaseId", db._id))
        .collect();
      for (const row of rows) {
        const statusVal = row.properties?.[db.taskConfig.statusPropId];
        const group =
          statusProp?.options?.find((o) => o.id === statusVal)?.group ?? "todo";
        if (group === "complete") continue;
        const due = row.properties?.[db.taskConfig.datePropId] as DateValue | undefined;
        const estimate = row.properties?.[db.taskConfig.estimatePropId];
        const prOption = priorityProp?.options?.find(
          (o) => o.id === row.properties?.[db.taskConfig!.priorityPropId]
        );
        out.push({
          rowId: row._id,
          title: row.title || "Untitled",
          due: due && typeof due.start === "number" ? due : undefined,
          estimateMin: typeof estimate === "number" ? estimate : undefined,
          priorityName: prOption?.name,
          priorityColor: prOption?.color,
          inProgress: group === "inprogress",
          statusPropId: db.taskConfig.statusPropId,
          completeOptionId: completeOption?.id,
          databaseId: db._id,
        });
      }
    }
    return out;
  },
});
