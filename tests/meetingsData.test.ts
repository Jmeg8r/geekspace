import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";

// WHAT: the meetings data layer: slim list, interrupted-meeting recovery, status
// validation, and a notes page that survives Reprocess once you've edited it.
// See docs/changes/2026-10-15-meetings/.

const modules = import.meta.glob("../convex/**/*.ts");

const SUMMARY = {
  summary: "We agreed to ship.",
  keyPoints: ["ship"],
  decisions: ["ship friday"],
  actionItems: ["Write release notes"],
  modelUsed: "gemma3:12b",
};

async function meeting(t: ReturnType<typeof convexTest>, fields: Partial<Doc<"meetings">> = {}) {
  return t.run((ctx) =>
    ctx.db.insert("meetings", {
      title: "Standup",
      status: "done",
      startedAt: 1_000,
      ...fields,
    })
  );
}

describe("meetings.list", () => {
  it("leaves transcripts and notes out of the list", async () => {
    const t = convexTest(schema, modules);
    await meeting(t, { transcript: "x".repeat(5000), ...SUMMARY });
    const [row] = await t.query(api.meetings.list, {});
    expect(row.title).toBe("Standup");
    for (const heavy of ["transcript", "summary", "keyPoints", "decisions", "actionItems"]) {
      expect(row).not.toHaveProperty(heavy);
    }
  });
});

describe("meetings.reconcileInterrupted", () => {
  it("turns meetings stuck mid-pipeline into errors, saying whether audio survived", async () => {
    const t = convexTest(schema, modules);
    const audio = await t.run((ctx) => ctx.storage.store(new Blob(["audio"])));
    const saved = await meeting(t, { status: "transcribing", audioStorageId: audio });
    const lost = await meeting(t, { status: "recording" });
    const done = await meeting(t, { status: "done" });
    const fresh = await meeting(t, { status: "recording", startedAt: 9_000 });

    await t.mutation(api.meetings.reconcileInterrupted, { before: 5_000 });

    const get = (id: Id<"meetings">) => t.run((ctx) => ctx.db.get(id));
    expect(await get(saved)).toMatchObject({ status: "error", error: expect.stringMatching(/re-run ai/i) });
    expect(await get(lost)).toMatchObject({ status: "error", error: expect.stringMatching(/lost/i) });
    expect((await get(done))?.status).toBe("done");
    expect((await get(fresh))?.status).toBe("recording");
  });
});

describe("meetings.setStatus", () => {
  it("rejects an unknown status", async () => {
    const t = convexTest(schema, modules);
    const id = await meeting(t);
    // @ts-expect-error -- an invalid status is the point: the validator must reject it at runtime.
    await expect(t.mutation(api.meetings.setStatus, { meetingId: id, status: "exploded" })).rejects.toThrow();
  });

  it("clears a stale error when the meeting leaves the error state", async () => {
    const t = convexTest(schema, modules);
    const id = await meeting(t, { status: "error", error: "Ollama not reachable" });
    await t.mutation(api.meetings.setStatus, { meetingId: id, status: "transcribing", progress: 0 });
    expect((await t.run((ctx) => ctx.db.get(id)))?.error).toBeUndefined();
  });
});

describe("meetings.finishSummary", () => {
  it("rebuilds an untouched notes page in place", async () => {
    const t = convexTest(schema, modules);
    const id = await meeting(t, { status: "summarizing" });
    await t.mutation(api.meetings.finishSummary, { meetingId: id, ...SUMMARY });
    const first = (await t.run((ctx) => ctx.db.get(id)))!.pageId!;
    await t.mutation(api.meetings.finishSummary, { meetingId: id, ...SUMMARY, summary: "Second pass." });
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.pageId).toBe(first);
    expect((await t.run((ctx) => ctx.db.get(first)))?.content).toContain("Second pass.");
  });

  it("never overwrites a notes page you edited: Reprocess makes a new one", async () => {
    const t = convexTest(schema, modules);
    const id = await meeting(t, { status: "summarizing" });
    await t.mutation(api.meetings.finishSummary, { meetingId: id, ...SUMMARY });
    const edited = (await t.run((ctx) => ctx.db.get(id)))!.pageId!;
    const myEdit = JSON.stringify([{ type: "paragraph", content: "my own notes" }]);
    await t.run((ctx) => ctx.db.patch(edited, { content: myEdit }));

    await t.mutation(api.meetings.finishSummary, { meetingId: id, ...SUMMARY, summary: "Second pass." });

    expect((await t.run((ctx) => ctx.db.get(edited)))?.content).toBe(myEdit);
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after?.pageId).not.toBe(edited);
    expect((await t.run((ctx) => ctx.db.get(after!.pageId!)))?.content).toContain("Second pass.");
  });
});
