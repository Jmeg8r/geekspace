import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  micErrorKind,
  startMicCapture,
  type MicEvent,
  type RecorderLike,
  type StreamLike,
} from "../src/capture/micCapture";

// WHAT: the Day Recorder's mic segmenting (plan PR 3d-2, spec R2 and R3). WHY tested: every
// segment must be a complete WebM (stop and restart at each boundary, never one long
// timeslice stream), its last chunk must reach the main process before its end marker, and a
// silent or lost device must be said out loud, never recorded as an empty file.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const T0 = Date.parse("2026-11-01T10:00:00Z");

class FakeRecorder implements RecorderLike {
  state: "inactive" | "recording" = "inactive";
  timesliceMs = 0;
  ondataavailable: RecorderLike["ondataavailable"] = null;
  onstop: RecorderLike["onstop"] = null;
  onerror: RecorderLike["onerror"] = null;
  constructor(
    readonly stream: StreamLike,
    readonly n: number
  ) {}
  start(timesliceMs: number) {
    this.state = "recording";
    this.timesliceMs = timesliceMs;
  }
  /** A timeslice chunk, as MediaRecorder delivers one: a Blob-like with arrayBuffer(). */
  chunk(text: string) {
    const bytes = new TextEncoder().encode(text);
    this.ondataavailable?.({ data: { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } });
  }
  /** Make the final chunk's bytes unreadable, as a Blob whose arrayBuffer() rejects. */
  unreadableFinal = false;
  stop() {
    this.state = "inactive";
    // MediaRecorder delivers the last data, then stop, asynchronously.
    queueMicrotask(() => {
      if (this.unreadableFinal) {
        this.ondataavailable?.({ data: { size: 3, arrayBuffer: () => Promise.reject(new Error("blob gone")) } });
      } else {
        this.chunk(`final-${this.n}`);
      }
      this.onstop?.();
    });
  }
}

function fakeStream() {
  const listeners = new Map<string, () => void>();
  const track = {
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
    end: () => listeners.get("ended")?.(),
  };
  const stream: StreamLike = { getAudioTracks: () => [track] };
  return { stream, track };
}

function harness(opts: { level?: () => number; segmentSec?: number; failStartAt?: number } = {}) {
  const { stream, track } = fakeStream();
  const recorders: FakeRecorder[] = [];
  const events: MicEvent[] = [];
  const capture = startMicCapture({
    stream,
    createRecorder: (s) => {
      const r = new FakeRecorder(s, recorders.length);
      recorders.push(r);
      if (opts.failStartAt === r.n) {
        r.start = () => {
          throw Object.assign(new Error("inactive stream"), { name: "InvalidStateError" });
        };
      }
      return r;
    },
    segmentSec: opts.segmentSec ?? 300,
    timesliceMs: 1000,
    readLevel: opts.level ?? (() => 0.2),
    emit: (e) => void events.push(e),
    silenceWarnSec: 25,
  });
  // Chunk payloads as text, so assertions read naturally.
  const view = () =>
    events.map((e) => (e.type === "chunk" ? { ...e, bytes: new TextDecoder().decode(e.bytes) } : e));
  return { capture, recorders, events, view, track };
}

/** Let the queued chunk conversions run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("startMicCapture", () => {
  it("opens segment 0 and tags each timeslice chunk with it", async () => {
    const h = harness();
    expect(h.recorders).toHaveLength(1);
    expect(h.recorders[0].timesliceMs).toBe(1000);
    h.recorders[0].chunk("a");
    h.recorders[0].chunk("b");
    await settle();
    expect(h.view()).toEqual([
      { type: "segmentStart", segment: 0, start: T0 },
      { type: "chunk", segment: 0, bytes: "a" },
      { type: "chunk", segment: 0, bytes: "b" },
    ]);
  });

  it("stops and restarts at each boundary on the same stream, so every segment is its own file", async () => {
    const h = harness({ segmentSec: 300 });
    await vi.advanceTimersByTimeAsync(300_000);
    await settle();
    expect(h.recorders).toHaveLength(2);
    expect(h.recorders[1].stream).toBe(h.recorders[0].stream);
    expect(h.recorders[0].state).toBe("inactive");
    expect(h.recorders[1].state).toBe("recording");
    expect(h.view()).toEqual([
      { type: "segmentStart", segment: 0, start: T0 },
      { type: "segmentStart", segment: 1, start: T0 + 300_000 },
      // Segment 0's last chunk reaches the main process before its end marker.
      { type: "chunk", segment: 0, bytes: "final-0" },
      { type: "segmentEnd", segment: 0, end: T0 + 300_000 },
    ]);
  });

  it("finalizes the open segment on stop, then says stopped, and starts nothing new", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(10_000);
    const done = h.capture.stop();
    await settle();
    await done;
    expect(h.view().slice(1)).toEqual([
      { type: "chunk", segment: 0, bytes: "final-0" },
      { type: "segmentEnd", segment: 0, end: T0 + 10_000 },
      { type: "stopped" },
    ]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.recorders).toHaveLength(1);
  });

  it("warns once after SILENCE_WARN_SEC below the floor, and says when signal returns", async () => {
    let level = 0;
    const h = harness({ level: () => level });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(h.events.some((e) => e.type === "silent")).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.events.filter((e) => e.type === "silent")).toEqual([{ type: "silent", silentSec: 25 }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.events.filter((e) => e.type === "silent")).toHaveLength(1);
    level = 0.3;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.events.at(-1)).toEqual({ type: "signal" });
  });

  it("reports a lost device and still finalizes what it recorded", async () => {
    const h = harness();
    h.track.end();
    await settle();
    await settle();
    expect(h.view().slice(1)).toEqual([
      { type: "error", kind: "deviceLost", message: "The microphone was disconnected." },
      { type: "chunk", segment: 0, bytes: "final-0" },
      { type: "segmentEnd", segment: 0, end: T0 },
      { type: "stopped" },
    ]);
  });

  it("reports a recorder error and stops", async () => {
    const h = harness();
    h.recorders[0].onerror?.({ error: { name: "UnknownError", message: "encoder failed" } });
    await settle();
    await settle();
    expect(h.events.find((e) => e.type === "error")).toEqual({
      type: "error",
      kind: "recorderError",
      message: "The recorder failed (UnknownError).",
    });
    expect(h.events.at(-1)).toEqual({ type: "stopped" });
  });
});

describe("startMicCapture, Codex #89 r1 [P1]", () => {
  it("reports a recorder that will not start, and never claims a segment", async () => {
    const h = harness({ failStartAt: 0 });
    await settle();
    expect(h.events).toEqual([
      { type: "error", kind: "recorderError", message: "The recorder could not start (InvalidStateError)." },
      { type: "stopped" },
    ]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.recorders).toHaveLength(1);
  });

  it("finishes the old segment when the next recorder will not start at a boundary", async () => {
    const h = harness({ failStartAt: 1 });
    await vi.advanceTimersByTimeAsync(300_000);
    await settle();
    expect(h.view().slice(1)).toEqual([
      { type: "error", kind: "recorderError", message: "The recorder could not start (InvalidStateError)." },
      { type: "chunk", segment: 0, bytes: "final-0" },
      { type: "segmentEnd", segment: 0, end: T0 + 300_000 },
      { type: "stopped" },
    ]);
  });

  it("says a chunk was lost, and fails, when its bytes cannot be read", async () => {
    const h = harness();
    h.recorders[0].ondataavailable?.({
      data: { size: 3, arrayBuffer: () => Promise.reject(new Error("blob gone")) },
    });
    await settle();
    await settle();
    expect(h.events.slice(1, 3)).toEqual([
      { type: "chunkFailed", segment: 0 },
      { type: "error", kind: "recorderError", message: "A recorded chunk could not be read." },
    ]);
    expect(h.events.at(-1)).toEqual({ type: "stopped" });
  });
});

describe("startMicCapture, Codex #89 r2 [P1]", () => {
  it("reports an unreadable final chunk before it says stopped", async () => {
    // The main process tears down on stopped, so an error queued behind it was never heard.
    const h = harness();
    h.recorders[0].unreadableFinal = true;
    await h.capture.stop();
    expect(h.events.slice(1).map((e) => e.type)).toEqual(["chunkFailed", "error", "segmentEnd", "stopped"]);
  });
});

describe("startMicCapture, Codex #89 r3 [P1]", () => {
  it("still reports a recorder error that lands after a stop was asked for, before stopped", async () => {
    // Chromium makes a failed recorder inactive and queues its error, data and stop events, so
    // a stop request can get in first; the error must not be lost to the stop guard.
    const h = harness();
    const done = h.capture.stop();
    h.recorders[0].onerror?.({ error: { name: "EncodingError" } });
    await done;
    expect(h.events.slice(1).map((e) => e.type)).toEqual(["error", "chunk", "segmentEnd", "stopped"]);
    expect(h.events[1]).toEqual({ type: "error", kind: "recorderError", message: "The recorder failed (EncodingError)." });
  });
});

describe("micErrorKind", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "noDevice"],
    ["OverconstrainedError", "noDevice"],
    ["NotReadableError", "unavailable"],
    ["AbortError", "unavailable"],
  ])("maps %s to %s", (name, kind) => {
    expect(micErrorKind({ name })).toBe(kind);
  });
});
