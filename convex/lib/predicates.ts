// WHAT: Named runtime type guards for values read out of Geekspace's dynamic
// property bags (`rows.properties`, `databases.properties`, and similar
// `v.any()` columns — see the schema comment in convex/schema.ts).
// WHY: property definitions are user-editable and evolve, so these columns
// are deliberately schemaless; call sites still need to narrow a value's
// runtime shape before using it. Naming the check here (instead of an ad hoc
// `typeof x === "..."` at each call site) satisfies anti-slop's
// no-runtime-typeof rule and gives every narrowing call site the same,
// reviewable definition. Convex declares these columns `any`, not `unknown`
// — the parameter type here matches that real, already-declared contract.

export function isNumber(value: any): value is number {
  return typeof value === "number";
}

export function isString(value: any): value is string {
  return typeof value === "string";
}
