// WHAT: Shared domain types used by both Convex functions and the React renderer.
// WHY: lives inside convex/ so server functions can import it without leaving the
// bundled directory, while the renderer imports it as plain TypeScript.

export type PropertyType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "relation"
  | "rollup"
  | "createdTime"
  | "updatedTime";

export type StatusGroup = "todo" | "inprogress" | "complete";

export interface SelectOption {
  id: string;
  name: string;
  color: string; // palette id, see optionColors
  group?: StatusGroup; // only for status properties
}

export type RollupAggregate =
  | "count"
  | "countValues"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "percentComplete";

export type NumberFormat = "plain" | "minutes" | "percent" | "dollar" | "progress";

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  options?: SelectOption[];
  numberFormat?: NumberFormat;
  /** relation: which database this links to, and the synced reverse property over there */
  relation?: { databaseId: string; syncedPropId?: string };
  rollup?: { relationPropId: string; targetPropId: string; aggregate: RollupAggregate };
  includeTime?: boolean;
}

/**
 * Date property value convention:
 * - includeTime === true  → start/end are real epoch milliseconds.
 * - includeTime !== true  → start/end are UTC midnight of the *calendar date*
 *   (timezone-free date, like Notion). Convert with calendar helpers before
 *   comparing against epoch timestamps.
 */
export interface DateValue {
  start: number;
  end?: number;
  includeTime?: boolean;
}

export type FilterOp =
  | "contains"
  | "notContains"
  | "is"
  | "isNot"
  | "isEmpty"
  | "isNotEmpty"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "before"
  | "after"
  | "checked"
  | "unchecked";

export interface FilterRule {
  propId: string;
  op: FilterOp;
  value?: string | number;
}

export interface FilterConfig {
  conjunction: "and" | "or";
  rules: FilterRule[];
}

export interface SortRule {
  propId: string;
  dir: "asc" | "desc";
}

export type ViewType = "table" | "board" | "list" | "calendar" | "timeline";

export interface TaskConfig {
  statusPropId: string;
  datePropId: string;
  estimatePropId: string;
  priorityPropId: string;
}

export const OPTION_COLOR_IDS = [
  "gray",
  "orange",
  "blue",
  "purple",
  "green",
  "red",
  "yellow",
  "pink",
  "teal",
  "brown",
] as const;

export type OptionColorId = (typeof OPTION_COLOR_IDS)[number];

export function makeId(): string {
  return (
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
  );
}
