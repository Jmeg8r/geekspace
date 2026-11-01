import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

// WHAT: what the Day Recorder assistant has read, and what it has spent (plan PR 6a, spec R8).
// WHY tested (Codex review of PR 6a, round 1): a time watermark skipped transcripts written late,
// resent part of a batch, and started 15 minutes back; the cap let a call overshoot it; and a
// failed write lost a paid reply or its proposals. Each item now carries whether it was read,
// marked in the same write that records the call's cost and keeps its proposals; a call
// reserves its worst case against the cap before it is made.
// SYNTHETIC: every text below is invented.

const modules = import.meta.glob("../convex/**/*.ts");
const MIN = 60_000;
const DAY = "2026-11-02";

async function seeded(capUsd: number | null = 1) {
  const t = convexTest(schema, modules);
  await t.mutation(api.seed.seedWorkspace, {});
  if (capUsd !== null) await t.mutation(api.dayRecorder.updateSettings, { dailyCapUsd: capUsd });
  return t;
}

type T = Awaited<ReturnType<typeof seeded>>;

async function transcript(t: T, start: number, text: string) {
  const day = new Date(start).toLocaleDateString("en-CA");
  const segmentId = await t.mutation(api.dayRecorder.addSegment, { day, kind: "mic", path: `${day}/mic-${start}.webm`, start, end: start + MIN });
  await t.mutation(api.dayRecorder.addTranscript, { segmentId, start, end: start + MIN, text });
  const row = await t.run((ctx) => ctx.db.query("transcripts").withIndex("by_segment", (q) => q.eq("segmentId", segmentId)).unique());
  return row!._id;
}

describe("assistant.unread", () => {
  it("[P1] lists unread text since the start, oldest first, and a transcript written late too", async () => {
    const t = await seeded();
    const now = Date.now();
    const since = now - 120 * MIN;
    await transcript(t, since - MIN, "SYNTHETIC before the start");
    await transcript(t, now - 20 * MIN, "SYNTHETIC on time");
    // Transcribed late: its audio is older than the last one read.
    const first = await t.query(api.assistant.unread, { since, limit: 50 });
    const reqId = await t.mutation(api.assistant.beginRequest, {
      day: DAY,
      reservedUsd: 0.01,
      transcriptIds: first.transcripts.map((r) => r._id),
      screenshotIds: [],
    });
    await t.mutation(api.assistant.settleRequest, { requestId: reqId!, costUsd: 0.001, inputTokens: 10, outputTokens: 1, proposals: [] });
    await transcript(t, now - 60 * MIN, "SYNTHETIC written late");
    const next = await t.query(api.assistant.unread, { since, limit: 50 });
    expect(first.transcripts.map((r) => r.text)).toEqual(["SYNTHETIC on time"]);
    expect(next.transcripts.map((r) => r.text)).toEqual(["SYNTHETIC written late"]);
  });

  it("limits what it lists, and refuses a bad limit", async () => {
    const t = await seeded();
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) await transcript(t, now - (10 - i) * MIN, `SYNTHETIC ${i}`);
    expect((await t.query(api.assistant.unread, { since: 0, limit: 2 })).transcripts).toHaveLength(2);
    await expect(t.query(api.assistant.unread, { since: 0, limit: 0 })).rejects.toThrow(/limit/i);
  });
});

describe("assistant.ensureStart", () => {
  it("[P1] keeps the first start it is given", async () => {
    const t = await seeded();
    expect(await t.mutation(api.assistant.ensureStart, { at: 1_000 })).toBe(1_000);
    expect(await t.mutation(api.assistant.ensureStart, { at: 2_000 })).toBe(1_000);
  });
});

describe("assistant requests and the cap", () => {
  it("[P1] refuses a call whose worst case doesn't fit what is left, counting reservations in flight", async () => {
    const t = await seeded(1);
    const a = await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.6, transcriptIds: [], screenshotIds: [] });
    expect(a).not.toBeNull();
    expect(await t.query(api.assistant.capStatus, { day: DAY })).toMatchObject({ spentUsd: 0.6, reached: false });
    expect(await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.5, transcriptIds: [], screenshotIds: [] })).toBeNull();
  });

  it("refuses every call with no cap set", async () => {
    const t = await seeded(null);
    expect(await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.001, transcriptIds: [], screenshotIds: [] })).toBeNull();
  });

  it("[P1] settling records the real cost in place of the reservation, marks exactly its items read, and keeps the proposals", async () => {
    const t = await seeded(1);
    const now = Date.now();
    const sent = await transcript(t, now - 5 * MIN, "SYNTHETIC sent");
    await transcript(t, now - 4 * MIN, "SYNTHETIC not sent");
    const id = await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.5, transcriptIds: [sent], screenshotIds: [] });
    const proposal = { type: "createTask" as const, title: "Send the deck", estimateMin: 30 };
    await t.mutation(api.assistant.settleRequest, { requestId: id!, costUsd: 0.02, inputTokens: 100, outputTokens: 20, proposals: [proposal] });
    // A settle sent again (its answer lost) changes nothing.
    await t.mutation(api.assistant.settleRequest, { requestId: id!, costUsd: 0.02, inputTokens: 100, outputTokens: 20, proposals: [proposal] });
    expect(await t.query(api.assistant.capStatus, { day: DAY })).toMatchObject({ spentUsd: 0.02 });
    expect((await t.query(api.assistant.unread, { since: 0, limit: 50 })).transcripts.map((r) => r.text)).toEqual(["SYNTHETIC not sent"]);
    const open = await t.query(api.assistant.openRequests, {});
    expect(open).toHaveLength(1);
    expect(open[0].proposals).toEqual([{ proposal, state: "pending" }]);
  });

  it("a call that failed before an answer frees its reservation and leaves its items unread", async () => {
    const t = await seeded(1);
    const item = await transcript(t, Date.now() - MIN, "SYNTHETIC");
    const id = await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.5, transcriptIds: [item], screenshotIds: [] });
    await t.mutation(api.assistant.failRequest, { requestId: id! });
    expect(await t.query(api.assistant.capStatus, { day: DAY })).toMatchObject({ spentUsd: 0 });
    expect((await t.query(api.assistant.unread, { since: 0, limit: 50 })).transcripts).toHaveLength(1);
  });

  it("[P1] a call abandoned in flight (a crash) stays counted at its reservation", async () => {
    const t = await seeded(1);
    await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.4, transcriptIds: [], screenshotIds: [] });
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("assistantRequests").collect()) await ctx.db.patch(r._id, { at: 0 });
    });
    await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.1, transcriptIds: [], screenshotIds: [] });
    expect(await t.query(api.assistant.capStatus, { day: DAY })).toMatchObject({ spentUsd: 0.5 });
    expect((await t.query(api.assistant.openRequests, {})).filter((r) => r.status === "inFlight")).toHaveLength(1);
  });

  it("[P1] applies each kept proposal once, refuses one Geekspace won't take, then closes the request", async () => {
    const t = await seeded(1);
    const id = await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.1, transcriptIds: [], screenshotIds: [] });
    await t.mutation(api.assistant.settleRequest, {
      requestId: id!,
      costUsd: 0.01,
      inputTokens: 1,
      outputTokens: 1,
      proposals: [
        { type: "createTask", title: "Book the retro", estimateMin: 15 },
        { type: "createTask", title: "", estimateMin: 15 },
      ],
    });
    await t.mutation(api.assistant.applyProposal, { requestId: id!, index: 0 });
    await t.mutation(api.assistant.applyProposal, { requestId: id!, index: 0 });
    await expect(t.mutation(api.assistant.applyProposal, { requestId: id!, index: 1 })).rejects.toThrow();
    await t.mutation(api.assistant.refuseProposal, { requestId: id!, index: 1 });
    const tasks = await t.run((ctx) => ctx.db.query("assistantActions").collect());
    expect(tasks.filter((a) => a.kind === "createTask")).toHaveLength(1);
    expect(await t.query(api.assistant.openRequests, {})).toEqual([]);
  });
});

// Codex 6a r2: a call that may have been paid for stays charged; a long item is read in parts.
describe("assistant requests, round 2", () => {
  it("[P1] an ambiguous failure is charged at its reservation, and its items are read again", async () => {
    const t = await seeded(1);
    const item = await transcript(t, Date.now() - MIN, "SYNTHETIC");
    const id = await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.3, transcriptIds: [item], screenshotIds: [] });
    await t.mutation(api.assistant.abandonRequest, { requestId: id! });
    expect(await t.query(api.assistant.capStatus, { day: DAY })).toMatchObject({ spentUsd: 0.3 });
    expect((await t.query(api.assistant.unread, { since: 0, limit: 50 })).transcripts).toHaveLength(1);
    expect(await t.query(api.assistant.openRequests, {})).toEqual([]);
  });

  it("[P1] a part of an item records how far it was read; the rest stays unread", async () => {
    const t = await seeded(1);
    const text = "SYNTHETIC ".repeat(10);
    const item = await transcript(t, Date.now() - MIN, text);
    const settle = async (end: number) => {
      const id = await t.mutation(api.assistant.beginRequest, {
        day: DAY,
        reservedUsd: 0.01,
        transcriptIds: [item],
        transcriptEnds: [end],
        screenshotIds: [],
      });
      await t.mutation(api.assistant.settleRequest, { requestId: id!, costUsd: 0.001, inputTokens: 1, outputTokens: 1, proposals: [] });
    };
    await settle(40);
    const after = await t.query(api.assistant.unread, { since: 0, limit: 50 });
    expect(after.transcripts).toHaveLength(1);
    expect(after.transcripts[0].readChars).toBe(40);
    await settle(text.length);
    expect((await t.query(api.assistant.unread, { since: 0, limit: 50 })).transcripts).toEqual([]);
  });

  it("refuses ends that don't match the items", async () => {
    const t = await seeded(1);
    const item = await transcript(t, Date.now() - MIN, "SYNTHETIC");
    await expect(
      t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.01, transcriptIds: [item], transcriptEnds: [1, 2], screenshotIds: [] })
    ).rejects.toThrow(/ends/);
  });
});

// Codex 6a r4 P1: a full page of rows too long for the cap hid every row after it.
describe("assistant.unread, past a page", () => {
  it("[P1] continues after a cursor, ties at its time included once", async () => {
    const t = await seeded(1);
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await transcript(t, now - (10 - i) * MIN, `SYNTHETIC ${i}`));
    const first = await t.query(api.assistant.unread, { since: 0, limit: 2 });
    expect(first.transcripts.map((r) => r.text)).toEqual(["SYNTHETIC 0", "SYNTHETIC 1"]);
    expect(first.transcriptsDone).toBe(false);
    const next = await t.query(api.assistant.unread, { since: 0, limit: 2, transcriptAfter: first.transcriptAfter! });
    expect(next.transcripts.map((r) => r.text)).toEqual(["SYNTHETIC 2"]);
    expect(next.transcriptsDone).toBe(true);
  });
});

// Codex 6a r5 P2: spec R8 logs every call with its tokens and cost, not just the day's total.
describe("assistant requests keep their own usage", () => {
  it("settling records the call's tokens and cost on the request", async () => {
    const t = await seeded(1);
    const id = await t.mutation(api.assistant.beginRequest, { day: DAY, reservedUsd: 0.2, transcriptIds: [], screenshotIds: [] });
    await t.mutation(api.assistant.settleRequest, { requestId: id!, costUsd: 0.0123, inputTokens: 456, outputTokens: 78, proposals: [] });
    const row = await t.run((ctx) => ctx.db.get(id!));
    expect(row).toMatchObject({ costUsd: 0.0123, inputTokens: 456, outputTokens: 78, reservedUsd: 0.2 });
  });
});
