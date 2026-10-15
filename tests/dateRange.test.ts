import { describe, expect, it } from "vitest";
import { pickDay } from "../src/lib/dateRange";

// Codex review of PR #52 [P2]: once reversed ranges are rejected at the boundary, the
// date picker must never emit one. Moving Oct 1–3 to Oct 10–12 used to send
// {start: Oct 10, end: Oct 3} first, which is now refused, and the second click then
// paired Oct 12 with the old Oct 1 start. See docs/changes/2026-10-15-row-integrity/.

const OCT = (d: number) => Date.UTC(2026, 9, d);

describe("pickDay", () => {
  it("moves a range past its old end without ever reversing it", () => {
    // Range Oct 1–3 is showing; the user clicks Oct 10 (new start)…
    const first = pickDay({ day: OCT(10), rangeMode: true, pickingEnd: false, start: OCT(1) });
    expect(first).toEqual({ start: OCT(10), end: OCT(10), pickingEnd: true });
    // …then Oct 12, using the picker's own pending start rather than the server's.
    const second = pickDay({ day: OCT(12), rangeMode: true, pickingEnd: true, start: first.start });
    expect(second).toEqual({ start: OCT(10), end: OCT(12), pickingEnd: false });
  });

  it("treats an end click before the start as a new start", () => {
    expect(pickDay({ day: OCT(2), rangeMode: true, pickingEnd: true, start: OCT(10) })).toEqual({
      start: OCT(2),
      end: OCT(2),
      pickingEnd: true,
    });
  });

  it("sets a single date outside range mode", () => {
    expect(pickDay({ day: OCT(5), rangeMode: false, pickingEnd: false, start: OCT(1) })).toEqual({
      start: OCT(5),
      end: undefined,
      pickingEnd: false,
    });
  });
});
