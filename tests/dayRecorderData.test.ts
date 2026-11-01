import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// WHAT: the Day Recorder's capture index in Convex. No call audio without a logged notice,
// media paths that cannot point outside the media root, and a 30-day retention selection
// that never reaches derived text. See docs/changes/2026-10-18-day-recorder/ (R5, R14).
// SYNTHETIC: every path, bundle id and line of text below is invented for the test.

const modules = import.meta.glob("../convex/**/*.ts");
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 15);

const segment = (over: Partial<{ day: string; kind: "mic" | "system" | "call"; path: string; start: number }> = {}) => {
  const start = over.start ?? NOW - 600_000;
  return {
    day: over.day ?? "2026-10-18",
    kind: over.kind ?? "mic",
    path: over.path ?? "2026-10-18/mic-1500.webm",
    start,
    end: start + 300_000,
  };
};

describe("dayRecorder.addSegment", () => {
  it("stores a mic segment", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.dayRecorder.addSegment, segment());
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("closed");
  });

  it("refuses call audio without a notice event", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.addSegment, segment({ kind: "call" }))).rejects.toThrow(/notice/i);
    expect(await t.run((ctx) => ctx.db.query("captureSegments").collect())).toEqual([]);
  });

  it("refuses call audio whose event is not a notice that was given", async () => {
    const t = convexTest(schema, modules);
    const declined = await t.mutation(api.dayRecorder.logEvent, { kind: "noticeDeclined", at: NOW });
    await expect(
      t.mutation(api.dayRecorder.addSegment, { ...segment({ kind: "call" }), noticeEventId: declined })
    ).rejects.toThrow(/notice/i);
  });

  it("stores call audio once the notice was given", async () => {
    const t = convexTest(schema, modules);
    const given = await t.mutation(api.dayRecorder.logEvent, { kind: "noticeGiven", at: NOW });
    const id = await t.mutation(api.dayRecorder.addSegment, { ...segment({ kind: "call" }), noticeEventId: given });
    expect((await t.run((ctx) => ctx.db.get(id)))?.noticeEventId).toBe(given);
  });

  it.each([
    "/Users/someone/secret.webm",
    "../outside.webm",
    "2026-10-18/../../etc/passwd",
    "2026-10-18\\mic.webm",
    "",
    "2026-10-19/mic.webm", // a path filed under another day than the segment's
  ])("refuses a path that is not <day>/<file> inside the media root: %j", async (path) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.addSegment, segment({ path }))).rejects.toThrow(/path/i);
  });

  it("refuses a malformed day or a segment that ends before it starts", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.addSegment, segment({ day: "18/10/2026" }))).rejects.toThrow(/day/i);
    const s = segment();
    await expect(t.mutation(api.dayRecorder.addSegment, { ...s, end: s.start - 1 })).rejects.toThrow(/end/i);
  });
});

describe("dayRecorder.addTranscript", () => {
  it("links the text to its segment and marks the segment transcribed", async () => {
    const t = convexTest(schema, modules);
    const segmentId = await t.mutation(api.dayRecorder.addSegment, segment());
    const s = segment();
    await t.mutation(api.dayRecorder.addTranscript, { segmentId, start: s.start, end: s.end, text: "I'll send the deck." });
    expect((await t.run((ctx) => ctx.db.get(segmentId)))?.status).toBe("transcribed");
  });
});

// Codex review of PR 3b-1: the helper names no app when a denylisted app owned the menu bar
// or the owner changed during the capture (protocol.md), so a shot with no app must store.
describe("dayRecorder.addScreenshot", () => {
  const shot = { day: "2026-10-18", path: "2026-10-18/shot-150000-000.heic", takenAt: NOW, ocrText: "Quarterly numbers" };

  it("stores a shot whose app is unknown", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(api.dayRecorder.addScreenshot, shot);
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.appBundleId).toBeUndefined();
  });

  it("still refuses an app id that is not a bundle id", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.addScreenshot, { ...shot, appBundleId: "not a bundle" })).rejects.toThrow(/bundle/i);
  });
});

describe("dayRecorder retention", () => {
  async function aged() {
    const t = convexTest(schema, modules);
    const old = await t.mutation(
      api.dayRecorder.addSegment,
      segment({ day: "2026-09-17", path: "2026-09-17/mic-1500.webm", start: NOW - 31 * DAY_MS })
    );
    const recent = await t.mutation(
      api.dayRecorder.addSegment,
      segment({ day: "2026-09-19", path: "2026-09-19/mic-1500.webm", start: NOW - 29 * DAY_MS })
    );
    const oldShot = await t.mutation(api.dayRecorder.addScreenshot, {
      day: "2026-09-17",
      path: "2026-09-17/shot-1500.heic",
      takenAt: NOW - 31 * DAY_MS,
      appBundleId: "com.apple.TextEdit",
      ocrText: "Quarterly numbers",
    });
    await t.mutation(api.dayRecorder.addTranscript, {
      segmentId: old,
      start: NOW - 31 * DAY_MS,
      end: NOW - 31 * DAY_MS + 300_000,
      text: "kept forever",
    });
    return { t, old, recent, oldShot };
  }

  it("selects media older than 30 days and nothing newer", async () => {
    const { t, old, oldShot } = await aged();
    const expired = await t.query(api.dayRecorder.expiredMedia, { now: NOW });
    expect(expired.segments.map((s) => s._id)).toEqual([old]);
    expect(expired.screenshots.map((s) => s._id)).toEqual([oldShot]);
  });

  it("marks purged media, logs one purge event with the count, and keeps the text", async () => {
    const { t, old, oldShot } = await aged();
    await t.mutation(api.dayRecorder.markPurged, { segmentIds: [old], screenshotIds: [oldShot], at: NOW });
    expect((await t.run((ctx) => ctx.db.get(old)))?.status).toBe("purged");
    const shot = await t.run((ctx) => ctx.db.get(oldShot));
    expect(shot?.purgedAt).toBe(NOW);
    expect(shot?.ocrText).toBe("Quarterly numbers");
    const transcripts = await t.run((ctx) => ctx.db.query("transcripts").collect());
    expect(transcripts.map((tr) => tr.text)).toEqual(["kept forever"]);
    const events = await t.run((ctx) => ctx.db.query("recorderEvents").collect());
    expect(events.filter((e) => e.kind === "purged").map((e) => e.count)).toEqual([2]);
    // Purged media is not selected again.
    const again = await t.query(api.dayRecorder.expiredMedia, { now: NOW });
    expect(again.segments).toEqual([]);
    expect(again.screenshots).toEqual([]);
  });

  it("refuses to purge media that has not expired", async () => {
    const { t, recent } = await aged();
    await expect(
      t.mutation(api.dayRecorder.markPurged, { segmentIds: [recent], screenshotIds: [], at: NOW })
    ).rejects.toThrow(/30 days/);
  });
});

describe("dayRecorder settings", () => {
  it("defaults to off, unpaused, an empty denylist, no cap, 30 s shots and 15 min batches", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.dayRecorder.getSettings, {})).toEqual({
      enabled: false,
      paused: false,
      denylist: [],
      dailyCapUsd: null,
      batchMin: 15,
      shotSec: 30,
    });
  });

  it("saves valid values", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.dayRecorder.updateSettings, {
      enabled: true,
      denylist: ["com.microsoft.teams2", "us.zoom.xos"],
      dailyCapUsd: 2.5,
    });
    expect(await t.query(api.dayRecorder.getSettings, {})).toMatchObject({
      enabled: true,
      denylist: ["com.microsoft.teams2", "us.zoom.xos"],
      dailyCapUsd: 2.5,
    });
  });

  it("saves pause apart from enabled, so a paused recorder stays enabled", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.dayRecorder.updateSettings, { enabled: true });
    await t.mutation(api.dayRecorder.updateSettings, { paused: true });
    expect(await t.query(api.dayRecorder.getSettings, {})).toMatchObject({ enabled: true, paused: true });
    await t.mutation(api.dayRecorder.updateSettings, { paused: false });
    expect(await t.query(api.dayRecorder.getSettings, {})).toMatchObject({ enabled: true, paused: false });
  });

  it.each([
    [{ denylist: ["not a bundle id"] }, /bundle/i],
    [{ dailyCapUsd: -1 }, /cap/i],
    [{ shotSec: 1 }, /shot/i],
    [{ batchMin: 0 }, /batch/i],
  ])("rejects %j", async (patch, message) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.updateSettings, patch)).rejects.toThrow(message);
  });
});

describe("dayRecorder capture day vs capture time", () => {
  // Decision 2026-10-21 (CSO finding 4016f9d6): a row's day must be a local day its own
  // capture time could fall on, in some timezone (UTC-12 to UTC+14), so the purge, which
  // selects by time, can never be pointed at a current day's file.
  it("rejects a screenshot whose day is far from its takenAt", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.dayRecorder.addScreenshot, {
        day: "2026-10-18",
        path: "2026-10-18/shot-150000-000.heic",
        takenAt: 0,
        ocrText: "SYNTHETIC",
      })
    ).rejects.toThrow(/does not match its capture time/);
  });

  it("rejects a segment whose day is far from its start", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.dayRecorder.addSegment, segment({ start: NOW - 31 * DAY_MS }))
    ).rejects.toThrow(/does not match its capture time/);
  });

  it.each([
    ["UTC+14, just after local midnight", Date.UTC(2026, 9, 17, 10, 0, 1)],
    ["UTC-12, just before local midnight", Date.UTC(2026, 9, 19, 11, 59, 59)],
  ])("accepts the edge of the day window: %s", async (_name, start) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.addSegment, segment({ start }))).resolves.toBeTruthy();
  });

  it.each([
    ["before any timezone's midnight", Date.UTC(2026, 9, 17, 9, 59, 59)],
    ["after every timezone's midnight", Date.UTC(2026, 9, 19, 12, 0, 0)],
  ])("rejects just outside the window: %s", async (_name, start) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.addSegment, segment({ start }))).rejects.toThrow(
      /does not match its capture time/
    );
  });
});

// Codex 3e-2 r1–r3: saving the denylist whole from the page let a stale copy undo an edit,
// so an app just denied, or one another window added, could lose its protection (R4). Each
// edit is now one atomic change to the list as the server holds it.
describe("dayRecorder denylist edits", () => {
  const list = async (t: ReturnType<typeof convexTest>) => (await t.query(api.dayRecorder.getSettings, {})).denylist;

  it("adds to the list as it is now, once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.dayRecorder.addToDenylist, { id: "com.example.mail" });
    await t.mutation(api.dayRecorder.addToDenylist, { id: "com.example.editor" });
    await t.mutation(api.dayRecorder.addToDenylist, { id: "com.example.mail" });
    expect(await list(t)).toEqual(["com.example.mail", "com.example.editor"]);
  });

  it("removes only that app, and keeps what another window added", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.dayRecorder.addToDenylist, { id: "com.example.mail" });
    await t.mutation(api.dayRecorder.addToDenylist, { id: "com.example.editor" });
    // Another window, between this window's edits.
    await t.mutation(api.dayRecorder.addToDenylist, { id: "com.example.notes" });
    await t.mutation(api.dayRecorder.removeFromDenylist, { id: "com.example.mail" });
    expect(await list(t)).toEqual(["com.example.editor", "com.example.notes"]);
  });

  it("removing an app that is not listed changes nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.dayRecorder.addToDenylist, { id: "com.example.mail" });
    await t.mutation(api.dayRecorder.removeFromDenylist, { id: "com.example.other" });
    expect(await list(t)).toEqual(["com.example.mail"]);
  });

  it("refuses an invalid bundle id at the boundary", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.dayRecorder.addToDenylist, { id: "not a bundle id" })).rejects.toThrow(
      'Invalid app bundle id "not a bundle id"'
    );
    await expect(t.mutation(api.dayRecorder.removeFromDenylist, { id: "../x" })).rejects.toThrow("Invalid app bundle id");
  });
});
