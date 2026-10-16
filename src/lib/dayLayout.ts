// WHAT: side-by-side columns for items that overlap on one day of the week grid.
// WHY: overlap must be judged on the spans as drawn (wall-clock minutes). On a fall-back
// day, 01:00–01:30 EDT and 01:00–01:30 EST never overlap in real time but draw in the same
// slot; comparing timestamps stacked them on top of each other.
// See docs/changes/2026-10-15-scheduler-dst-perf/.
export type Span = readonly [startMin: number, endMin: number];

export function layoutBySpan<T>(
  items: readonly T[],
  spanOf: (item: T) => Span
): Array<{ item: T; col: number; cols: number }> {
  const sorted = items
    .map((item) => ({ item, span: spanOf(item) }))
    .sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  const colEnds: number[] = [];
  const placed = sorted.map(({ item, span }) => {
    let col = colEnds.findIndex((end) => end <= span[0]);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(span[1]);
    } else {
      colEnds[col] = span[1];
    }
    return { item, col };
  });
  const cols = colEnds.length || 1;
  return placed.map((p) => ({ ...p, cols }));
}
