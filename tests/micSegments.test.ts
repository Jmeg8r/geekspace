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
const NAME = "mic-102000-005.webm";
const bytes = (s: string) => new TextEncoder().encode(s).buffer;

function harness(opts: { maxChunkBytes?: number; maxSegmentBytes?: number; failRows?: boolean } = {}) {
  const rows: MicSegmentRow[] = [];
  const logs: string[] = [];
  const writer = createMicSegmentWriter({
    root,
    addSegment: async (row) => {
      if (opts.failRows) throw Object.assign(new Error(`row rejected: ${row.path}`), { name: "ArgumentValidationError" });
      rows.push(row);
    },
    log: (m) => void logs.push(m),
    ...(opts.maxChunkBytes !== undefined && { maxChunkBytes: opts.maxChunkBytes }),
    ...(opts.maxSegmentBytes !== undefined && { maxSegmentBytes: opts.maxSegmentBytes }),
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
    const h = harness();
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("a") });
    h.writer.handle({ type: "segmentStart", segment: 1, start: END });
    h.writer.handle({ type: "chunk", segment: 1, bytes: bytes("b") });
    h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("A") });
    h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
    await h.writer.drain();
    expect(fs.readFileSync(path.join(root, DAY, NAME), "utf8")).toBe("aA");
    expect(h.rows.map((r) => r.start)).toEqual([START]);
  });

  it.each([
    [{ type: "nope" }, /unknown/],
    [{ type: "chunk", segment: 0, bytes: bytes("x") }, /not started/],
    [{ type: "segmentStart", segment: 0, start: Number.NaN }, /start/],
    [{ type: "segmentStart", segment: -1, start: START }, /segment/],
    [{ type: "segmentStart", segment: 1.5, start: START }, /segment/],
    [{ type: "segmentEnd", segment: 0, end: END }, /not started/],
    [null, /not a message/],
    ["chunk", /not a message/],
  ])("refuses %j", (message, reason) => {
    const h = harness();
    const result = h.writer.handle(message);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("refuses a chunk that is not bytes, or too big, and never writes it", () => {
    const h = harness({ maxChunkBytes: 4 });
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    expect(h.writer.handle({ type: "chunk", segment: 0, bytes: "text" }).ok).toBe(false);
    expect(h.writer.handle({ type: "chunk", segment: 0, bytes: bytes("12345") }).ok).toBe(false);
    expect(fs.readFileSync(path.join(root, DAY, `.partial-${NAME}`), "utf8")).toBe("");
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

  it("never indexes an empty segment, and says so", async () => {
    const h = harness();
    h.writer.handle({ type: "segmentStart", segment: 0, start: START });
    const result = h.writer.handle({ type: "segmentEnd", segment: 0, end: END });
    await h.writer.drain();
    expect(!result.ok && result.reason).toMatch(/empty/);
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
