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
  it("defaults to off, an empty denylist, no cap, 30 s shots and 15 min batches", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.dayRecorder.getSettings, {})).toEqual({
      enabled: false,
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
