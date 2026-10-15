// WHAT: what one click on a day does in the date picker. A new start in range mode
// collapses the end onto it until the end is picked, so the picker never emits a reversed
// range (the server rejects those). The caller passes its own pending start, not the
// server's copy, so a quick second click pairs with the start just chosen.
// See docs/changes/2026-10-15-row-integrity/.
/** The range after a click, and whether the next click picks its end. */
export type DayPick = { start: number; end: number | undefined; pickingEnd: boolean };

export function pickDay({
  day,
  rangeMode,
  pickingEnd,
  start,
}: {
  day: number;
  rangeMode: boolean;
  pickingEnd: boolean;
  start: number | undefined;
}): DayPick {
  if (rangeMode && pickingEnd && start !== undefined && day >= start) {
    return { start, end: day, pickingEnd: false };
  }
  return { start: day, end: rangeMode ? day : undefined, pickingEnd: rangeMode };
}
