import type { Doc } from "../../convex/_generated/dataModel";
import type {
  DateValue,
  FilterConfig,
  FilterOp,
  FilterRule,
  PropertyDef,
  SortRule,
} from "../../convex/lib/types";

// WHAT: Client-side filter/sort evaluation for database views.
// WHY: rows.list returns the whole (personal-scale) database reactively; views
// are pure lenses, so evaluating them client-side keeps the server simple and
// view switching instant.

export type RowDoc = Doc<"rows"> & { computed?: Record<string, number | null> };

function numberValue(row: RowDoc, def: PropertyDef): number | null {
  if (def.type === "rollup") return row.computed?.[def.id] ?? null;
  const v = row.properties?.[def.id];
  return typeof v === "number" ? v : null;
}

function textValue(row: RowDoc, def: PropertyDef): string {
  if (def.type === "title") return row.title ?? "";
  const v = row.properties?.[def.id];
  return typeof v === "string" ? v : "";
}

export function evalRule(row: RowDoc, rule: FilterRule, def: PropertyDef): boolean {
  const raw = row.properties?.[rule.propId];
  switch (def.type) {
    case "title":
    case "text":
    case "url": {
      const s = textValue(row, def).toLowerCase();
      const target = String(rule.value ?? "").toLowerCase();
      switch (rule.op) {
        case "contains": return s.includes(target);
        case "notContains": return !s.includes(target);
        case "is": return s === target;
        case "isNot": return s !== target;
        case "isEmpty": return s === "";
        case "isNotEmpty": return s !== "";
        default: return true;
      }
    }
    case "number":
    case "rollup": {
      const n = numberValue(row, def);
      const target = Number(rule.value);
      switch (rule.op) {
        case "eq": return n !== null && n === target;
        case "neq": return n === null || n !== target;
        case "gt": return n !== null && n > target;
        case "lt": return n !== null && n < target;
        case "isEmpty": return n === null;
        case "isNotEmpty": return n !== null;
        default: return true;
      }
    }
    case "select":
    case "status": {
      const id = typeof raw === "string" ? raw : "";
      switch (rule.op) {
        case "is": return id === rule.value;
        case "isNot": return id !== rule.value;
        case "isEmpty": return id === "";
        case "isNotEmpty": return id !== "";
        default: return true;
      }
    }
    case "multiSelect": {
      const arr = Array.isArray(raw) ? (raw as string[]) : [];
      switch (rule.op) {
        case "contains": return arr.includes(String(rule.value));
        case "notContains": return !arr.includes(String(rule.value));
        case "isEmpty": return arr.length === 0;
        case "isNotEmpty": return arr.length > 0;
        default: return true;
      }
    }
    case "checkbox": {
      const b = raw === true;
      return rule.op === "checked" ? b : rule.op === "unchecked" ? !b : true;
    }
    case "date": {
      const dv = raw as DateValue | undefined;
      const target = Number(rule.value);
      switch (rule.op) {
        case "is": return dv !== undefined && dv.start === target;
        case "before": return dv !== undefined && dv.start < target;
        case "after": return dv !== undefined && dv.start > target;
        case "isEmpty": return dv === undefined;
        case "isNotEmpty": return dv !== undefined;
        default: return true;
      }
    }
    case "relation": {
      const arr = Array.isArray(raw) ? raw : [];
      switch (rule.op) {
        case "isEmpty": return arr.length === 0;
        case "isNotEmpty": return arr.length > 0;
        default: return true;
      }
    }
    default:
      return true;
  }
}

export function applyFilters(
  rows: RowDoc[],
  filters: FilterConfig | undefined,
  props: PropertyDef[]
): RowDoc[] {
  if (!filters || filters.rules.length === 0) return rows;
  const defs = new Map(props.map((p) => [p.id, p]));
  return rows.filter((row) => {
    const results = filters.rules.map((rule) => {
      const def = defs.get(rule.propId);
      return def ? evalRule(row, rule, def) : true;
    });
    return filters.conjunction === "or"
      ? results.some(Boolean)
      : results.every(Boolean);
  });
}

function compareValues(a: RowDoc, b: RowDoc, def: PropertyDef): number {
  switch (def.type) {
    case "title":
    case "text":
    case "url":
      return textValue(a, def).localeCompare(textValue(b, def));
    case "number":
    case "rollup": {
      const na = numberValue(a, def);
      const nb = numberValue(b, def);
      return (na ?? Number.NEGATIVE_INFINITY) - (nb ?? Number.NEGATIVE_INFINITY);
    }
    case "select":
    case "status": {
      // Sort by option order, like Notion.
      const idx = (row: RowDoc) => {
        const v = row.properties?.[def.id];
        const i = def.options?.findIndex((o) => o.id === v) ?? -1;
        return i === -1 ? Number.POSITIVE_INFINITY : i;
      };
      return idx(a) - idx(b);
    }
    case "multiSelect": {
      const len = (row: RowDoc) =>
        Array.isArray(row.properties?.[def.id])
          ? (row.properties[def.id] as string[]).length
          : 0;
      return len(a) - len(b);
    }
    case "checkbox":
      return Number(a.properties?.[def.id] === true) - Number(b.properties?.[def.id] === true);
    case "date": {
      const ms = (row: RowDoc) =>
        (row.properties?.[def.id] as DateValue | undefined)?.start ??
        Number.POSITIVE_INFINITY;
      return ms(a) - ms(b);
    }
    case "createdTime":
      return a._creationTime - b._creationTime;
    case "updatedTime":
      return a.updatedAt - b.updatedAt;
    default:
      return 0;
  }
}

export function applySorts(
  rows: RowDoc[],
  sorts: SortRule[] | undefined,
  props: PropertyDef[]
): RowDoc[] {
  if (!sorts || sorts.length === 0) return rows;
  const defs = new Map(props.map((p) => [p.id, p]));
  return [...rows].sort((a, b) => {
    for (const s of sorts) {
      const def = defs.get(s.propId);
      if (!def) continue;
      const cmp = compareValues(a, b, def);
      if (cmp !== 0) return s.dir === "desc" ? -cmp : cmp;
    }
    return a.order - b.order;
  });
}

export function applyView(
  rows: RowDoc[],
  props: PropertyDef[],
  filters?: FilterConfig,
  sorts?: SortRule[]
): RowDoc[] {
  return applySorts(applyFilters(rows, filters, props), sorts, props);
}

/** Filter operators that make sense for a property type (for the filter menu UI). */
export function opsForType(type: PropertyDef["type"]): Array<{ op: FilterOp; label: string }> {
  switch (type) {
    case "title":
    case "text":
    case "url":
      return [
        { op: "contains", label: "contains" },
        { op: "notContains", label: "does not contain" },
        { op: "is", label: "is" },
        { op: "isNot", label: "is not" },
        { op: "isEmpty", label: "is empty" },
        { op: "isNotEmpty", label: "is not empty" },
      ];
    case "number":
    case "rollup":
      return [
        { op: "eq", label: "=" },
        { op: "neq", label: "≠" },
        { op: "gt", label: ">" },
        { op: "lt", label: "<" },
        { op: "isEmpty", label: "is empty" },
        { op: "isNotEmpty", label: "is not empty" },
      ];
    case "select":
    case "status":
      return [
        { op: "is", label: "is" },
        { op: "isNot", label: "is not" },
        { op: "isEmpty", label: "is empty" },
        { op: "isNotEmpty", label: "is not empty" },
      ];
    case "multiSelect":
      return [
        { op: "contains", label: "contains" },
        { op: "notContains", label: "does not contain" },
        { op: "isEmpty", label: "is empty" },
        { op: "isNotEmpty", label: "is not empty" },
      ];
    case "checkbox":
      return [
        { op: "checked", label: "is checked" },
        { op: "unchecked", label: "is unchecked" },
      ];
    case "date":
      return [
        { op: "is", label: "is" },
        { op: "before", label: "is before" },
        { op: "after", label: "is after" },
        { op: "isEmpty", label: "is empty" },
        { op: "isNotEmpty", label: "is not empty" },
      ];
    case "relation":
      return [
        { op: "isEmpty", label: "is empty" },
        { op: "isNotEmpty", label: "is not empty" },
      ];
    default:
      return [];
  }
}
