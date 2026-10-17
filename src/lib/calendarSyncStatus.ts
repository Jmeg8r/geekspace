// WHAT: the calendar sync's status note for calendars that didn't read cleanly.
// WHY its own module: pure, so it is testable without the Convex client macSync loads.
import type { MacCalendarFetch } from "./integrations";

/**
 * The status suffix for calendars that didn't read cleanly (their events were kept), or ""
 * when every calendar in scope read in full. Scope is the Settings selection, or every
 * calendar listed when syncing all. A partial list is itself an incomplete read.
 */
export function incompleteReadNote(
  selected: string[],
  fetched: Pick<MacCalendarFetch, "complete" | "present">
): string {
  if (selected.length === 0 && fetched.present === null) {
    return " · couldn't list every calendar; kept existing events";
  }
  const inScope = selected.length > 0 ? selected : (fetched.present ?? []);
  const partial = inScope.filter((name) => !fetched.complete.includes(name));
  return partial.length > 0 ? ` · couldn't fully read ${partial.join(", ")}; kept its events` : "";
}
