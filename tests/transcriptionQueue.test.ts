import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolMissingError, WHISPER_MODELS, transcribeFile } from "../electron/meetingProcessor.mjs";
import { RETRY_AFTER_MS, createTranscriptionQueue, type PendingSegment } from "../electron/transcriptionQueue.mjs";

// WHAT: local transcription of Day Recorder segments (plan PR 5, spec R7). WHY tested: every
// closed segment must end as a transcript row, or as transcribed with nothing to say, or as
// failed, never silently left; and transcript text must never reach a log.
// SYNTHETIC: segment ids, paths and text are invented.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const seg = (n: number): PendingSegment => ({
  _id: `seg-${n}`,
  path: `2026-11-01/mic-0900${n}0-000-${n}.webm`,
  start: 1_000 * n,
  end: 1_000 * n + 300_000,
});

type Outcome = { transcript: string } | { silent: true } | { noSpeech: true };

function harness(transcribe: (file: string) => Promise<Outcome>) {
  const rows: { segmentId: string; start: number; end: number; text: string }[] = [];
  const statuses: [string, string][] = [];
  const logs: string[] = [];
  const queue = createTranscriptionQueue({
    transcribe,
    resolvePath: (p: string) => `/media/${p}`,
    addTranscript: async (row) => void rows.push(row),
    setSegmentStatus: async (segmentId, status) => void statuses.push([segmentId, status]),
    log: (m: string) => void logs.push(m),
  });
  return { queue, rows, statuses, logs };
}

describe("WHISPER_MODELS", () => {
  it("pins small.en for the Day Recorder (spec R7) and keeps base.en for Meetings", () => {
    expect(WHISPER_MODELS["small.en"]).toEqual({
      file: "ggml-small.en.bin",
      size: 487_614_201,
      sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    });
    expect(WHISPER_MODELS["base.en"].file).toBe("ggml-base.en.bin");
  });
});

describe("createTranscriptionQueue", () => {
  it("transcribes oldest first, one at a time, into transcript rows with the segment's span", async () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const h = harness(async (file) => {
      running++;
      most = Math.max(most, running);
      order.push(file);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { transcript: `SYNTHETIC words for ${file}` };
    });
    h.queue.offer([seg(2), seg(1)]);
    await vi.runAllTimersAsync();
    await h.queue.idle();
    expect(order).toEqual(["/media/2026-11-01/mic-090010-000-1.webm", "/media/2026-11-01/mic-090020-000-2.webm"]);
    expect(most).toBe(1);
    expect(h.rows.map((r) => [r.segmentId, r.start, r.end])).toEqual([
      ["seg-1", 1_000, 301_000],
      ["seg-2", 2_000, 302_000],
    ]);
  });

  it("marks silence and no speech transcribed, with no row", async () => {
    const outcomes: Outcome[] = [{ silent: true }, { noSpeech: true }];
    const h = harness(async () => outcomes.shift()!);
    h.queue.offer([seg(1), seg(2)]);
    await h.queue.idle();
    expect(h.rows).toEqual([]);
    expect(h.statuses).toEqual([
      ["seg-1", "transcribed"],
      ["seg-2", "transcribed"],
    ]);
  });

  it("marks a failure failed, and logs no transcript text", async () => {
    const h = harness(async () => {
      throw new Error("whisper exited 1: SYNTHETIC partial transcript");
    });
    h.queue.offer([seg(1)]);
    await h.queue.idle();
    expect(h.statuses).toEqual([["seg-1", "failed"]]);
    expect(h.logs.join("\n")).not.toContain("SYNTHETIC");
    expect(h.logs.join("\n")).toContain("seg-1");
  });

  it("takes each segment once, however often it is offered", async () => {
    const transcribe = vi.fn(async () => ({ transcript: "SYNTHETIC" }));
    const h = harness(transcribe);
    h.queue.offer([seg(1)]);
    h.queue.offer([seg(1)]);
    await h.queue.idle();
    h.queue.offer([seg(1)]);
    await h.queue.idle();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  // Codex 5 r1 P1: an empty first delivery left the queue stuck for good.
  it("works after an empty first delivery", async () => {
    const transcribe = vi.fn(async () => ({ transcript: "SYNTHETIC" }));
    const h = harness(transcribe);
    h.queue.offer([]);
    await h.queue.idle();
    h.queue.offer([seg(1)]);
    await h.queue.idle();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  // Codex 5 r1 P1: a pause and a failed write waited for a new delivery that may never come.
  it("pauses without failing anything when a tool is missing, and tries again on its own", async () => {
    let missing = true;
    const transcribe = vi.fn(async () => {
      if (missing) throw new ToolMissingError("whisper.cpp not found");
      return { transcript: "SYNTHETIC" };
    });
    const h = harness(transcribe);
    h.queue.offer([seg(1), seg(2)]);
    await h.queue.idle();
    expect(h.statuses).toEqual([]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(h.logs.filter((l) => l.includes("not found"))).toHaveLength(1);
    missing = false;
    h.queue.offer([seg(1), seg(2)]);
    await h.queue.idle();
    expect(transcribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    await h.queue.idle();
    expect(h.rows.map((r) => r.segmentId)).toEqual(["seg-1", "seg-2"]);
  });

  it("writes a result again on its own when the backend was down, without transcribing again", async () => {
    let fail = true;
    const rows: string[] = [];
    const transcribe = vi.fn(async () => ({ transcript: "SYNTHETIC" }));
    const queue = createTranscriptionQueue({
      transcribe,
      resolvePath: (p: string) => p,
      addTranscript: async (row) => {
        if (fail) throw new Error("backend down");
        rows.push(row.segmentId);
      },
      setSegmentStatus: async () => {},
      log: () => {},
    });
    queue.offer([seg(1)]);
    await queue.idle();
    fail = false;
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
    await queue.idle();
    expect(rows).toEqual(["seg-1"]);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("refuses a path outside the media root as failed, without transcribing it", async () => {
    const transcribe = vi.fn(async () => ({ transcript: "SYNTHETIC" }));
    const statuses: string[] = [];
    const queue = createTranscriptionQueue({
      transcribe,
      resolvePath: () => {
        throw new Error("outside the media root");
      },
      addTranscript: async () => {},
      setSegmentStatus: async (_id, status) => void statuses.push(status),
      log: () => {},
    });
    queue.offer([seg(1)]);
    await queue.idle();
    expect(transcribe).not.toHaveBeenCalled();
    expect(statuses).toEqual(["failed"]);
  });

  it("starts nothing new after stop", async () => {
    const transcribe = vi.fn(async () => ({ transcript: "SYNTHETIC" }));
    const h = harness(transcribe);
    h.queue.stop();
    h.queue.offer([seg(1)]);
    await h.queue.idle();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

// Codex 5 r1 P1: a model that could not be downloaded failed the whole backlog for good.
describe("transcribeFile, a model that can't be fetched", () => {
  it("is a missing prerequisite (retried later), with the download's own message", async () => {
    const result = transcribeFile({ input: "/tmp/none.webm", model: "small.en" }, undefined, {
      toolStatus: async () => ({ ffmpeg: true, whisper: true, model: false, modelName: "ggml-base.en.bin" }),
      modelVerified: async () => false,
      ensureModel: async () => {
        throw new Error("Download failed: HTTP 503");
      },
    });
    await expect(result).rejects.toBeInstanceOf(ToolMissingError);
    await expect(result).rejects.toThrow("Download failed: HTTP 503");
  });
});
