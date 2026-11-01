import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMicSegmentWriter, type MicSegmentRow } from "../electron/micSegments.mjs";
import { localDay } from "../electron/dayRecorderMedia.mjs";

// WHAT: the main-process side of mic capture (plan PR 3d-2): chunks from the capture window
// are appended to a hidden partial file and, at the segment's end, renamed and indexed as a
// `mic` captureSegments row. WHY tested: these messages come from a renderer, so each one is
// checked here before it touches the disk; and a segment must never become a row unless its
// file is complete and non-empty (spec R2, R3).

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gs-mic-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const START = new Date(2026, 10, 1, 10, 20, 0, 5).getTime();
const END = START + 300_000;
const DAY = localDay(START);
// Local time for reading, then the epoch ms, which never repeats (Codex #89 r3).
const NAME = `mic-102000-005-${START}.webm`;
const bytes = (s: string) => new TextEncoder().encode(s).buffer;

type WriteSync = (fd: number, buf: Uint8Array, offset: number, length: number) => number;

function harness(
  opts: {
    maxChunkBytes?: number;
    maxSegmentBytes?: number;
    failRows?: boolean;
    now?: number;
    writeSync?: WriteSync;
    quarantineMs?: number;
  } = {}
) {
  const rows: MicSegmentRow[] = [];
  const logs: string[] = [];
  const writer = createMicSegmentWriter({
    root,
    addSegment: async (row) => {
      if (opts.failRows) throw Object.assign(new Error(`row rejected: ${row.path}`), { name: "ArgumentValidationError" });
      rows.push(row);
    },
    log: (m) => void logs.push(m),
    now: () => opts.now ?? START,
    ...(opts.writeSync && { writeSync: opts.writeSync }),
    ...(opts.maxChunkBytes !== undefined && { maxChunkBytes: opts.maxChunkBytes }),
    ...(opts.maxSegmentBytes !== undefined && { maxSegmentBytes: opts.maxSegmentBytes }),
    ...(opts.quarantineMs !== undefined && { quarantineMs: opts.quarantineMs }),
  });
  return { writer, rows, logs };
}

describe("createMicSegmentWriter", () => {
  it("writes a hidden partial, then renames it and adds a mic row at the segment's end", async () => {
    const h = harness();
    expect(h.writer.handle({ type: "segmentStart", segment: 0, start: START })).toEqual({ ok: true });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("one-") });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("two") });
    const partial = path.join(root, DAY, `.partial-${NAME}`);
    expect(fs.readFileSync(partial, "utf8")).toBe("one-two");
    expect(h.writer.handle({ type: "segmentEnd", segment: 0, end: END })).toEqual({ ok: true });
    await h.writer.drain();
    const final = path.join(root, DAY, NAME);
    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.readFileSync(final, "utf8")).toBe("one-two");
    expect(fs.statSync(final).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, DAY)).mode & 0o777).toBe(0o700);
    expect(h.rows).toEqual([{ day: DAY, kind: "mic", path: `${DAY}/${NAME}`, start: START, end: END }]);
  });

  it("keeps two segments apart while the old one finishes after the new one starts", async () => {
    // Codex #89 r2 [P2]: with the clock at START, segment 1 (at END) was refused as too far
    // ahead, and the test checked only segment 0. The clock is now at the boundary.
    const h = harness({ now: END });
    const ok = { ok: true };
    expect(h.writer.handle({ type: "segmentStart", segment: 0, start: START })).toEqual(ok);
    expect(h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("a") })).toEqual(ok);
    expect(h.writer.handle({ type: "segmentStart", segment: 1, start: END })).toEqual(ok);
    expect(h.writer.handle({ type: "chunk", segment: 1, bytes: bytes("b") })).toEqual(ok);
    expect(h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("A") })).toEqual(ok);
    expect(h.writer.handle({ type: "segmentEnd", segment: 0, end: END })).toEqual(ok);
    expect(h.writer.handle({ type: "chunk", segment: 1, bytes: bytes("B") })).toEqual(ok);
    expect(h.writer.handle({ type: "segmentEnd", segment: 1, end: END + 300_000 })).toEqual(ok);
    await h.writer.drain();
    expect(fs.readFileSync(path.join(root, DAY, NAME), "utf8")).toBe("aA");
    expect(fs.readFileSync(path.join(root, localDay(END), `mic-102500-005-${END}.webm`), "utf8")).toBe("bB");
    expect(h.rows.map((r) => [r.start, r.end])).toEqual([
      [START, END],
      [END, END + 300_000],
    ]);
  });

  describe("Codex #89 r3 [P1]: a finished recording is never overwritten", () => {
    it("keeps both segments that start at the same local time in the fall-back hour", async () => {
      // 01:20:00.005 EDT and 01:20:00.005 EST, an hour apart, on 2026-11-01 in New York.
      const tz = process.env.TZ;
      process.env.TZ = "America/New_York";
      try {
        const a = Date.parse("2026-11-01T05:20:00.005Z");
        const b = Date.parse("2026-11-01T06:20:00.005Z");
        const h = harness({ now: b });
        for (const [segment, start, text] of [
          [0, a, "first"],
          [1, b, "second"],
        ] as const) {
          expect(h.writer.handle({ type: "segmentStart", segment, start })).toEqual({ ok: true });
          h.writer.handle({ type: "chunk", segment, bytes: bytes(text) });
          expect(h.writer.handle({ type: "segmentEnd", segment, end: start + 1000 })).toEqual({ ok: true });
        }
        await h.writer.drain();
        expect(new Set(h.rows.map((r) => r.path)).size).toBe(2);
        expect(h.rows.map((r) => fs.readFileSync(path.join(root, r.path), "utf8"))).toEqual(["first", "second"]);
      } finally {
        if (tz === undefined) delete process.env.TZ;
        else process.env.TZ = tz;
      }
    });

    it("refuses to finish onto a file that already exists, and leaves that file alone", async () => {
      const h = harness();
      fs.mkdirSync(path.join(root, DAY), { recursive: true });
      fs.writeFileSync(path.join(root, DAY, NAME), "earlier recording");
      h.writer.handle({ type: "segmentStart", segment: 0, start: START });
      h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("new") });
      const result = h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
      await h.writer.drain();
      expect(!result.ok && result.reason).toMatch(/exists/);
      expect(fs.readFileSync(path.join(root, DAY, NAME), "utf8")).toBe("earlier recording");
      expect(h.rows).toEqual([]);
    });
  });

  it.each([
    [{ type: "nope" }, /unknown/],
    [{ type: "chunk", segment: 0, bytes: bytes("x") }, /not started/],
    [{ type: "segmentStart", segment: 0, start: Number.NaN }, /start/],
    [{ type: "segmentStart", segment: -1, start: START }, /segment/],
    [{ type: "segmentStart", segment: 1.5, start: START }, /segment/],
    [{ type: "segmentEnd", segment: 0, end: END }, /not started/],
    [null, /not a message/],
    // Security review of 3d-2: a time far off the clock made an Invalid Date day folder.
    [{ type: "segmentStart", segment: 0, start: 1e20 }, /start/],
    [{ type: "segmentStart", segment: 0, start: START - 2 * 86_400_000 }, /start/],
    [{ type: "segmentStart", segment: 0, start: START + 3_600_000 }, /start/],
    ["chunk", /not a message/],
  ])("refuses %j", (message, reason) => {
    const h = harness();
    const result = h.writer.handle(message);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([["not bytes", "text"], ["too big", bytes("12345")]])("refuses a chunk that is %s, and never writes it", (_label, raw) => {
    // Each case on its own segment: after one refusal the segment is dropped (Codex #89 r1).
    const h = harness({ maxChunkBytes: 4 });
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    expect(h.writer.handle({ type: "chunk", segment: 0, bytes: raw }).ok).toBe(false);
    expect(fs.readFileSync(path.join(root, DAY, `.partial-${NAME}`), "utf8")).toBe("");
  });

  describe("Codex #89 r1 [P1]: a segment with a missing chunk never becomes a row", () => {
    it("drops a segment whose chunk was refused, even when the rest arrives", async () => {
      const h = harness({ maxChunkBytes: 4 });
      h.writer.handle({ type: "segmentStart", segment: 0, start: START });
      h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("HEAD") });
      expect(h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("MIDDLE") }).ok).toBe(false);
      h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("TAIL") });
      expect(h.writer.handle({ type: "segmentEnd", segment: 0, end: END })).toEqual({ ok: true, dropped: true });
      await h.writer.drain();
      expect(h.rows).toEqual([]);
      expect(fs.readdirSync(path.join(root, DAY))).toEqual([]);
    });

    it("drops a segment the window says lost a chunk", async () => {
      const h = harness();
      h.writer.handle({ type: "segmentStart", segment: 0, start: START });
      h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("a") });
      expect(h.writer.handle({ type: "chunkFailed", segment: 0 })).toEqual({ ok: true });
      expect(h.writer.handle({ type: "segmentEnd", segment: 0, end: END })).toEqual({ ok: true, dropped: true });
      await h.writer.drain();
      expect(h.rows).toEqual([]);
    });

    it("writes every byte of a chunk across short writes", async () => {
      const h = harness({ writeSync: (fd, buf, offset, length) => fs.writeSync(fd, buf, offset, Math.min(2, length)) });
      h.writer.handle({ type: "segmentStart", segment: 0, start: START });
      h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("WHOLE-CHUNK") });
      h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
      await h.writer.drain();
      expect(fs.readFileSync(path.join(root, DAY, NAME), "utf8")).toBe("WHOLE-CHUNK");
    });

    it("drops the segment when the disk takes no bytes at all", async () => {
      const h = harness({ writeSync: () => 0 });
      h.writer.handle({ type: "segmentStart", segment: 0, start: START });
      expect(h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("a") }).ok).toBe(false);
      expect(h.writer.handle({ type: "segmentEnd", segment: 0, end: END })).toEqual({ ok: true, dropped: true });
      expect(h.rows).toEqual([]);
    });
  });

  it("refuses a segment that grows past its cap", () => {
    const h = harness({ maxSegmentBytes: 5 });
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    expect(h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("123") }).ok).toBe(true);
    const over = h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("456") });
    expect(!over.ok && over.reason).toMatch(/cap/);
  });

  it("refuses a duplicate or out-of-order segment start, and an end before the start", () => {
    const h = harness();
    h.writer.handle({ type: "segmentStart", segment: 1, start: START });
    expect(h.writer.handle({ type: "segmentStart", segment: 1, start: START }).ok).toBe(false);
    expect(h.writer.handle({ type: "segmentStart", segment: 0, start: START }).ok).toBe(false);
    expect(h.writer.handle({ type: "segmentEnd", segment: 1, end: START - 1 }).ok).toBe(false);
  });

  it("never indexes an empty segment, and reports it as empty for the caller to judge", async () => {
    // The probe's first run (plan PR 3d-2): a stop just after a boundary leaves a final
    // segment with no audio yet. Mid-recording that means a dead mic; at a stop it doesn't.
    // The controller knows which, so the writer only reports it.
    const h = harness();
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    const result = h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
    await h.writer.drain();
    expect(result).toEqual({ ok: true, empty: true });
    expect(h.rows).toEqual([]);
    expect(fs.readdirSync(path.join(root, DAY))).toEqual([]);
  });

  it("keeps the file and logs only the error name when its row is refused", async () => {
    const h = harness({ failRows: true });
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("a") });
    h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
    await h.writer.drain();
    expect(fs.existsSync(path.join(root, DAY, NAME))).toBe(true);
    expect(h.logs.join("\n")).toMatch(/ArgumentValidationError/);
    // A Convex validation error echoes its arguments; the log keeps the name only.
    expect(h.logs.join("\n")).not.toMatch(/row rejected/);
  });

  it("leaves an unfinished segment's partial for the retention sweep at close", async () => {
    const h = harness();
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("a") });
    await h.writer.close();
    expect(fs.readdirSync(path.join(root, DAY))).toEqual([`.partial-${NAME}`]);
    expect(h.writer.handle({ type: "segmentStart", segment: 1, start: END }).ok).toBe(false);
  });
});

// Codex 4b r3 P3: when a call starts, the mic's open segment holds the call's opening audio
// (detection takes up to a poll), and a segment that just ended may too. Both are discarded,
// never finished: nothing of a call reaches disk before its notice.
describe("createMicSegmentWriter, a call starting", () => {
  it("[P1] discards the open segment at once: no file, no row, and later chunks write nothing", async () => {
    const h = harness();
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("before") });
    h.writer.discardOpen();
    const partial = path.join(root, DAY, `.partial-${NAME}`);
    expect(fs.existsSync(partial)).toBe(false);
    expect(h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("call") })).toEqual({ ok: true });
    expect(h.writer.handle({ type: "segmentEnd", segment: 0, end: END })).toMatchObject({ ok: true, dropped: true });
    await h.writer.drain();
    expect(h.rows).toEqual([]);
    expect(fs.readdirSync(path.join(root, DAY))).toEqual([]);
  });

  it("[P1] discards a segment that ended within the quarantine, too", async () => {
    const h = harness({ quarantineMs: 60_000 });
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("tail") });
    h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
    expect(fs.existsSync(path.join(root, DAY, NAME))).toBe(false);
    h.writer.discardOpen();
    await h.writer.close();
    expect(h.rows).toEqual([]);
    expect(fs.readdirSync(path.join(root, DAY))).toEqual([]);
  });

  it("finishes a quarantined segment once its quarantine is over", async () => {
    const h = harness({ quarantineMs: 30 });
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("tail") });
    h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
    await new Promise((r) => setTimeout(r, 80));
    await h.writer.drain();
    expect(h.rows).toEqual([{ day: DAY, kind: "mic", path: `${DAY}/${NAME}`, start: START, end: END }]);
  });

  it("finishes a quarantined segment at close: a stop is not a call", async () => {
    const h = harness({ quarantineMs: 60_000 });
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("tail") });
    h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
    await h.writer.close();
    expect(h.rows).toHaveLength(1);
  });
});
