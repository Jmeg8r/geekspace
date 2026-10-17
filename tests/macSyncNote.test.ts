import { describe, expect, it } from "vitest";
import { incompleteReadNote } from "../src/lib/calendarSyncStatus";

// WHAT: a calendar that didn't read cleanly is reported, in both selected and
// all-calendars mode. Codex review of PR #58, round 2. See docs/changes/2026-10-16-electron-sync/.

describe("incompleteReadNote", () => {
  it("reports a failed calendar when syncing all calendars", () => {
    expect(incompleteReadNote([], { complete: [], present: ["Work"] })).toMatch(/Work/);
  });

  it("reports a calendar list that could not be read in full", () => {
    expect(incompleteReadNote([], { complete: ["Work"], present: null })).toMatch(/couldn't list/);
  });

  it("reports a failed selected calendar", () => {
    expect(incompleteReadNote(["Work", "Home"], { complete: ["Work"], present: ["Work", "Home"] })).toMatch(/Home/);
  });

  it("is empty when everything in scope read in full", () => {
    expect(incompleteReadNote([], { complete: ["Work", "Home"], present: ["Work", "Home"] })).toBe("");
    expect(incompleteReadNote(["Work"], { complete: ["Work"], present: ["Work", "Home"] })).toBe("");
  });
});
