import { describe, expect, it } from "vitest";
import {
  approveLabel,
  dayWindow,
  discardLabel,
  groupActions,
  sourceLink,
  timeline,
  undoLabel,
  type DayAction,
  type DayRecordRows,
} from "../src/lib/dayRecord";

// WHAT: the Day Record view's logic (plan PR 6c, spec R12, R13, Accessibility). WHY tested:
// Undo and Approve are labelled with what they do, never a bare "Undo"; every summary line and
// action links to the item it came from; and a day is the local day, DST included.
// SYNTHETIC: every id and text below is invented.

const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m).getTime();

describe("dayWindow", () => {
  it("is local midnight to the next local midnight, named by its local date", () => {
    const w = dayWindow(new Date(2026, 10, 2, 15, 30));
    expect(w.day).toBe("2026-11-02");
    expect(w.from).toBe(new Date(2026, 10, 2).getTime());
    expect(w.to).toBe(new Date(2026, 10, 3).getTime());
  });

  it("steps whole days, so a DST change gives a 23- or 25-hour day, not a shifted one", () => {
    const w = dayWindow(new Date(2026, 10, 1, 12), 0);
    expect(new Date(w.to).getHours()).toBe(0);
    expect(dayWindow(new Date(2026, 10, 2, 12), -1).day).toBe("2026-11-01");
  });
});

const task: DayAction = { _id: "a1", kind: "createTask", at: at(10), groupId: "g1", title: "Send the deck", sourceSegmentId: "seg1" };
const block: DayAction = { _id: "a2", kind: "createBlock", at: at(10), groupId: "g1", start: at(14), end: at(15) };
const draft: DayAction = { _id: "a3", kind: "draftLinear", at: at(11), groupId: "g2", issueRef: "ENG-42", sourceScreenshotId: "shot1" };

describe("groupActions and undoLabel", () => {
  it("groups a task with its block, oldest first, and keeps whether the group was undone", () => {
    const groups = groupActions([draft, block, task, { ...task, _id: "a4", groupId: "g3", undoneAt: at(12) }]);
    expect(groups.map((g) => [g.groupId, g.actions.map((a) => a._id), g.undone])).toEqual([
      ["g1", ["a1", "a2"], false],
      ["g2", ["a3"], false],
      ["g3", ["a4"], true],
    ]);
  });

  it("says what Undo will undo", () => {
    const [g1, g2] = groupActions([task, block, draft]);
    expect(undoLabel(g1)).toBe("Undo: added 'Send the deck'");
    expect(undoLabel(g2)).toBe("Undo: drafted an update to ENG-42");
    expect(undoLabel(groupActions([block])[0])).toMatch(/^Undo: blocked /);
    // A task deleted since keeps a label that still says what it was.
    expect(undoLabel(groupActions([{ ...task, title: null }])[0])).toBe("Undo: added a task");
  });
});

describe("approveLabel and discardLabel", () => {
  it("name the issue, never a bare Approve or Discard", () => {
    expect(approveLabel({ issueRef: "ENG-42" })).toBe("Send to ENG-42");
    expect(discardLabel({ issueRef: "ENG-42" })).toBe("Discard the ENG-42 draft");
  });
});

const record: DayRecordRows = {
  transcripts: [
    { _id: "tr2", segmentId: "seg2", start: at(13), end: at(13, 1), text: "SYNTHETIC later" },
    { _id: "tr1", segmentId: "seg1", start: at(9, 5), end: at(9, 6), text: "SYNTHETIC I'll send the deck" },
  ],
  screenshots: [{ _id: "shot1", takenAt: at(11, 30), ocrText: "SYNTHETIC Q4 plan", purged: false, appBundleId: "com.example.editor" }],
  more: { transcripts: false, screenshots: false },
};

describe("timeline and sourceLink", () => {
  it("merges the day's transcripts and screens, oldest first, each with an anchor", () => {
    expect(timeline(record).map((e) => [e.kind, e.anchor])).toEqual([
      ["transcript", "src-seg-seg1"],
      ["screenshot", "src-shot-shot1"],
      ["transcript", "src-seg-seg2"],
    ]);
  });

  it("links an item to its source in the day's record, or to nothing when it is not that day's", () => {
    expect(sourceLink({ sourceSegmentId: "seg1" }, record)).toEqual({ anchor: "src-seg-seg1", text: expect.stringMatching(/^said at /) });
    expect(sourceLink({ sourceScreenshotId: "shot1" }, record)).toEqual({ anchor: "src-shot-shot1", text: expect.stringMatching(/^on screen at /) });
    expect(sourceLink({ sourceSegmentId: "seg-elsewhere" }, record)).toBeNull();
    expect(sourceLink({}, record)).toBeNull();
  });
});
