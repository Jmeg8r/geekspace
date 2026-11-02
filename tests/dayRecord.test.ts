import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// WHAT: what the Day Record view reads (plan PR 6c, spec R12, R13): one day's transcripts and
// screens, what the assistant did that day, the drafts waiting for approval, and the day's
// summary. WHY tested: the view is where James checks the assistant's work, so every item must
// carry the source it links to, and a day must not leak into the next.
// SYNTHETIC: every text below is invented.

const modules = import.meta.glob("../convex/**/*.ts");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = "2026-11-02";

async function seeded() {
  const t = convexTest(schema, modules);
  await t.mutation(api.seed.seedWorkspace, {});
  return t;
}

type T = Awaited<ReturnType<typeof seeded>>;

async function transcript(t: T, start: number, text: string) {
  const day = new Date(start).toLocaleDateString("en-CA");
  const segmentId = await t.mutation(api.dayRecorder.addSegment, { day, kind: "mic", path: `${day}/mic-${start}.webm`, start, end: start + MIN });
  await t.mutation(api.dayRecorder.addTranscript, { segmentId, start, end: start + MIN, text });
  return segmentId;
}

async function screen(t: T, takenAt: number, ocrText: string, purgedAt?: number) {
  return t.run((ctx) =>
    ctx.db.insert("screenshots", {
      day: DAY,
      path: `${DAY}/shot-${takenAt}.heic`,
      takenAt,
      appBundleId: "com.example.editor",
      ocrText,
      ...(purgedAt !== undefined && { purgedAt }),
    })
  );
}

describe("assistant.dayRecord", () => {
  it("returns the day's transcripts and screens, oldest first, and nothing from the days around it", async () => {
    const t = await seeded();
    const from = Date.UTC(2026, 10, 2, 5);
    const to = from + 24 * HOUR;
    await transcript(t, from - MIN, "SYNTHETIC the day before");
    const seg = await transcript(t, from + 3 * HOUR, "SYNTHETIC I'll send the deck by Thursday");
    const early = await screen(t, from + HOUR, "SYNTHETIC Q4 plan");
    const gone = await screen(t, from + 2 * HOUR, "SYNTHETIC old screen", from + 30 * HOUR);
    await screen(t, to, "SYNTHETIC the day after");
    const record = await t.query(api.assistant.dayRecord, { from, to });
    expect(record.transcripts.map((r) => [r.segmentId, r.text])).toEqual([[seg, "SYNTHETIC I'll send the deck by Thursday"]]);
    expect(record.screenshots.map((r) => [r._id, r.purged])).toEqual([
      [early, false],
      [gone, true],
    ]);
    expect(record.more).toEqual({ transcripts: false, screenshots: false });
  });

  it("refuses a window that is backwards or longer than a day and a DST hour", async () => {
    const t = await seeded();
    await expect(t.query(api.assistant.dayRecord, { from: 10, to: 5 })).rejects.toThrow(/day/);
    await expect(t.query(api.assistant.dayRecord, { from: 0, to: 26 * HOUR })).rejects.toThrow(/day/);
  });
});

describe("assistant.dayActions", () => {
  it("lists the day's actions with what each one names, for its Undo label", async () => {
    const t = await seeded();
    const blockStart = Date.now() + 24 * HOUR;
    await t.mutation(api.assistant.applyActions, {
      actions: [
        { type: "createTask", title: "Send the deck", estimateMin: 60, block: { start: blockStart, end: blockStart + HOUR } },
        { type: "draftLinear", issueRef: "ENG-42", body: "SYNTHETIC: the deck went out" },
      ],
    });
    const actions = await t.query(api.assistant.dayActions, { from: Date.now() - HOUR, to: Date.now() + HOUR });
    expect(actions.map((a) => a.kind).sort()).toEqual(["createBlock", "createTask", "draftLinear"]);
    expect(actions.find((a) => a.kind === "createTask")).toMatchObject({ title: "Send the deck" });
    expect(actions.find((a) => a.kind === "createBlock")).toMatchObject({ start: blockStart, end: blockStart + HOUR });
    expect(actions.find((a) => a.kind === "draftLinear")).toMatchObject({ issueRef: "ENG-42" });
    // One Undo per commitment: a task and its block share a group; the draft has its own.
    const group = (kind: string) => actions.find((a) => a.kind === kind)!.groupId;
    expect(group("createTask")).toBe(group("createBlock"));
    expect(group("draftLinear")).not.toBe(group("createTask"));
  });
});

describe("assistant.reviewQueue", () => {
  it("lists the drafts waiting for approval, and says when a last send may have gone through", async () => {
    const t = await seeded();
    await t.run(async (ctx) => {
      await ctx.db.insert("externalDrafts", { target: "linear", issueRef: "ENG-1", body: "SYNTHETIC one", status: "pending", createdAt: 2, updatedAt: 2 });
      await ctx.db.insert("externalDrafts", { target: "linear", issueRef: "ENG-2", body: "SYNTHETIC two", status: "pending", deliveryUnknown: true, createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("externalDrafts", { target: "linear", issueRef: "ENG-3", body: "SYNTHETIC sent", status: "sent", createdAt: 3, updatedAt: 3 });
    });
    const queue = await t.query(api.assistant.reviewQueue, {});
    expect(queue.map((d) => [d.issueRef, d.deliveryUnknown])).toEqual([
      ["ENG-2", true],
      ["ENG-1", false],
    ]);
  });
});

describe("assistant day summaries", () => {
  it("keeps the newest summary of a day, each item with its source", async () => {
    const t = await seeded();
    const seg = await transcript(t, Date.UTC(2026, 10, 2, 15), "SYNTHETIC");
    expect(await t.query(api.assistant.daySummary, { day: DAY })).toBeNull();
    await t.mutation(api.assistant.saveSummary, { day: DAY, items: [{ text: "SYNTHETIC first pass", sourceSegmentId: seg }] });
    await t.mutation(api.assistant.saveSummary, { day: DAY, items: [{ text: "SYNTHETIC agreed to send the deck", sourceSegmentId: seg }] });
    expect(await t.query(api.assistant.daySummary, { day: DAY })).toMatchObject({ items: [{ text: "SYNTHETIC agreed to send the deck", sourceSegmentId: seg }] });
  });

  it("refuses a bad day, an empty or overlong item, too many items, or an item without exactly one source", async () => {
    const t = await seeded();
    const seg = await transcript(t, Date.UTC(2026, 10, 2, 15), "SYNTHETIC");
    const shot = await screen(t, Date.UTC(2026, 10, 2, 16), "SYNTHETIC");
    const ok = (text: string) => ({ text, sourceSegmentId: seg });
    await expect(t.mutation(api.assistant.saveSummary, { day: "Nov 2", items: [ok("x")] })).rejects.toThrow();
    await expect(t.mutation(api.assistant.saveSummary, { day: DAY, items: [ok("")] })).rejects.toThrow();
    await expect(t.mutation(api.assistant.saveSummary, { day: DAY, items: [ok("x".repeat(2001))] })).rejects.toThrow();
    await expect(t.mutation(api.assistant.saveSummary, { day: DAY, items: Array.from({ length: 51 }, () => ok("x")) })).rejects.toThrow();
    // Codex 6c r1 P1: spec R13, every item links to its source.
    await expect(t.mutation(api.assistant.saveSummary, { day: DAY, items: [{ text: "x" }] })).rejects.toThrow(/source/);
    await expect(t.mutation(api.assistant.saveSummary, { day: DAY, items: [{ text: "x", sourceSegmentId: seg, sourceScreenshotId: shot }] })).rejects.toThrow(/source/);
  });
});

// Codex 6c r1 P1: the summary reads the whole day a page at a time, not the view's first 500.
describe("assistant.dayTranscripts and dayScreens", () => {
  it("pages one kind of the day's items, oldest first, to the end", async () => {
    const t = await seeded();
    const from = Date.UTC(2026, 10, 2, 5);
    for (let i = 0; i < 5; i++) await transcript(t, from + i * MIN, `SYNTHETIC ${i}`);
    await screen(t, from + HOUR, "SYNTHETIC screen");
    const first = await t.query(api.assistant.dayTranscripts, { from, to: from + 24 * HOUR, paginationOpts: { numItems: 2, cursor: null } });
    expect(first.page.map((r) => r.text)).toEqual(["SYNTHETIC 0", "SYNTHETIC 1"]);
    expect(first.isDone).toBe(false);
    let cursor = first.continueCursor;
    const rest: string[] = [];
    for (;;) {
      const next = await t.query(api.assistant.dayTranscripts, { from, to: from + 24 * HOUR, paginationOpts: { numItems: 2, cursor } });
      rest.push(...next.page.map((r) => r.text));
      if (next.isDone) break;
      cursor = next.continueCursor;
    }
    expect(rest).toEqual(["SYNTHETIC 2", "SYNTHETIC 3", "SYNTHETIC 4"]);
    const screens = await t.query(api.assistant.dayScreens, { from, to: from + 24 * HOUR, paginationOpts: { numItems: 10, cursor: null } });
    expect(screens.page.map((r) => r.ocrText)).toEqual(["SYNTHETIC screen"]);
  });
});

