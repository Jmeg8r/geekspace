// WHAT: writes the mic segments the hidden capture window streams (plan PR 3d-2, spec R2).
// Each segment's chunks are appended to a hidden `.partial-mic-*.webm` in its day folder; at
// segmentEnd the file is renamed and a `mic` captureSegments row is added.
// WHY every message is checked here: they come from a renderer, and this code writes into
// the media root. A message that fails a check is refused before anything touches the disk.
// WHY a partial file: a crash leaves only `.partial-*`, which no row names and which the
// retention sweep removes (dayRecorderMedia.mjs); a finished name always means a whole file.
// WHY a broken segment is dropped (Codex #89 r1): once one of its chunks is refused, short or
// lost, the rest can still arrive, but the file has a hole in it. It gets no file and no row.
// WHY chunks wait for the helper (Codex review of PR 4b, rounds 3 and 4): a call is seen a poll
// after it began, so the mic's latest audio may be the call's. With waitForClassification, each
// chunk stays in memory until gs-capture says its audio-use polls have looked past the time it
// arrived (audioClassified), and a segment is finished only once its end has been. A call, or a
// never-record app, seen in between discards what waits, and the discard lasts for the window:
// segments that start after it write nothing. Nothing of a call reaches disk before its notice.
// WHY synchronous writes: chunks are about a second of Opus each (a few KB), and appending
// them in arrival order is what keeps the file a valid WebM.
import fs from "node:fs";
import path from "node:path";
import { localDay } from "./dayRecorderMedia.mjs";

// A 1 s Opus chunk is a few KB. Anything near this cap is not audio from our recorder.
export const MAX_CHUNK_BYTES = 1024 * 1024;
// 5 minutes of Opus is about 2 MB; the cap bounds what a misbehaving window can write.
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
// One recording and the one finishing behind it, at a boundary.
const MAX_OPEN = 2;
// How long close() waits for row writes still in flight.
const DRAIN_MS = 5_000;
// A segment starts now, give or take: a day back covers a window that ran across midnight or
// a slow handoff, a minute ahead covers clock skew between processes. Anything else is not a
// real start, and would only make a junk day folder.
const START_PAST_MS = 86_400_000;
const START_FUTURE_MS = 60_000;

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isSegment = (x) => Number.isSafeInteger(x) && x >= 0;
const pad = (n, w = 2) => String(n).padStart(w, "0");

/**
 * `mic-HHMMSS-mmm-<epoch ms>.webm`: local time to read, then the start's epoch ms. WHY the
 * epoch (Codex #89 r3): local time repeats in the fall-back hour, and two segments with one
 * name would have the second replace the first.
 */
function fileName(start) {
  const d = new Date(start);
  return `mic-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}-${start}.webm`;
}

function asBytes(x) {
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (x instanceof Uint8Array) return x;
  return null;
}

export function createMicSegmentWriter({
  root,
  addSegment,
  log,
  maxChunkBytes = MAX_CHUNK_BYTES,
  maxSegmentBytes = MAX_SEGMENT_BYTES,
  now = Date.now,
  writeSync = fs.writeSync,
  // Hold chunks until classified (the Day Recorder). Off, chunks are written as they come.
  waitForClassification = false,
  // A write that fails while catching up, outside any message: the caller fails the mic.
  onError = (reason) => log(reason),
}) {
  const open = new Map();
  // Segments whose end came, waiting for it to be classified: segment -> { s, endAt, arrival }.
  const ending = new Map();
  // Set by discardOpen, for the rest of this writer (one capture window).
  let discarding = false;
  let classifiedThrough = -Infinity;
  let waiters = [];
  const pending = new Set();
  let highest = -1;
  let closed = false;

  const refuse = (reason) => ({ ok: false, reason });

  function begin(segment, start) {
    if (!isSegment(segment)) return refuse("segmentStart needs a segment number");
    const t = now();
    if (!isNum(start) || start < t - START_PAST_MS || start > t + START_FUTURE_MS) {
      return refuse("segmentStart needs a start time near now");
    }
    if (segment <= highest) return refuse(`segment ${segment} is not after segment ${highest}`);
    if (open.size >= MAX_OPEN) return refuse("too many segments open at once");
    const day = localDay(start);
    const name = fileName(start);
    if (discarding) {
      // A call or a never-record app is going on: this segment writes nothing at all.
      highest = segment;
      open.set(segment, { segment, fd: null, day, name, start, bytes: 0, broken: true, discarded: true, queue: [] });
      return { ok: true };
    }
    const dir = path.join(root, day);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const partial = path.join(dir, `.partial-${name}`);
    const fd = fs.openSync(partial, "wx", 0o600);
    highest = segment;
    open.set(segment, { segment, fd, partial, final: path.join(dir, name), day, name, start, bytes: 0, broken: false, queue: [] });
    return { ok: true };
  }

  /** Write every byte, across short writes; a write that takes nothing is a disk error. */
  function writeAll(fd, bytes) {
    let off = 0;
    while (off < bytes.byteLength) {
      const n = writeSync(fd, bytes, off, bytes.byteLength - off);
      if (!(n > 0)) throw Object.assign(new Error("the disk took no bytes"), { code: "ESHORTWRITE" });
      off += n;
    }
  }

  function append(segment, raw) {
    const s = open.get(segment);
    if (!s) return refuse(`segment ${segment} was not started`);
    if (s.broken) return { ok: true };
    const bytes = asBytes(raw);
    const why = !bytes
      ? "chunk bytes must be binary"
      : bytes.byteLength > maxChunkBytes
        ? `chunk of ${bytes.byteLength} bytes is over the ${maxChunkBytes}-byte cap`
        : s.bytes + bytes.byteLength > maxSegmentBytes
          ? `segment ${segment} would pass the ${maxSegmentBytes}-byte cap`
          : null;
    if (why) {
      s.broken = true;
      return refuse(why);
    }
    s.bytes += bytes.byteLength;
    if (waitForClassification) {
      s.queue.push({ bytes, at: now() });
      return { ok: true };
    }
    try {
      writeAll(s.fd, bytes);
    } catch (err) {
      s.broken = true;
      return refuse(`could not write mic audio (${err?.code ?? err?.name ?? "Error"})`);
    }
    return { ok: true };
  }

  /** The window could not read one of this segment's chunks. */
  function lost(segment) {
    const s = open.get(segment);
    if (!s) return refuse(`segment ${segment} was not started`);
    s.broken = true;
    return { ok: true };
  }

  function end(segment, endAt) {
    const s = open.get(segment);
    if (!s) return refuse(`segment ${segment} was not started`);
    if (!isNum(endAt) || endAt < s.start) return refuse("segmentEnd needs an end time after the start");
    open.delete(segment);
    // Discarded for a call: its file is already gone, or never was.
    if (s.discarded) return { ok: true, dropped: true };
    if (s.broken) {
      // Already reported when it broke; a file with a hole in it is not kept.
      fs.closeSync(s.fd);
      fs.rmSync(s.partial, { force: true });
      return { ok: true, dropped: true };
    }
    if (s.bytes === 0) {
      // No row and no file. Whether that is a dead mic or a stop just after a boundary is the
      // caller's call (micController.mjs).
      fs.closeSync(s.fd);
      fs.rmSync(s.partial, { force: true });
      return { ok: true, empty: true };
    }
    if (waitForClassification) {
      ending.set(segment, { s, endAt, arrival: now() });
      catchUp();
      return { ok: true };
    }
    fs.closeSync(s.fd);
    return finish(s, endAt);
  }

  /** Write what waits up to the classified time; false when a write failed (reported). */
  function writeClassified(s) {
    while (s.queue.length > 0 && s.queue[0].at <= classifiedThrough) {
      const { bytes } = s.queue.shift();
      try {
        writeAll(s.fd, bytes);
      } catch (err) {
        s.broken = true;
        s.queue = [];
        onError(`could not write mic audio (${err?.code ?? err?.name ?? "Error"})`);
        return false;
      }
    }
    return true;
  }

  /** Write and finish what the helper has classified. Never throws: failures go to onError. */
  function catchUp() {
    for (const s of open.values()) if (!s.discarded && !s.broken) writeClassified(s);
    for (const [segment, e] of ending) {
      if (!writeClassified(e.s)) {
        ending.delete(segment);
        dropFile(e.s);
        continue;
      }
      if (e.s.queue.length > 0 || e.arrival > classifiedThrough) break;
      ending.delete(segment);
      try {
        fs.closeSync(e.s.fd);
        const result = finish(e.s, e.endAt);
        if (!result.ok) onError(result.reason);
      } catch (err) {
        onError(`could not finish mic segment ${segment} (${err?.code ?? err?.name ?? "Error"})`);
      }
    }
    if (!busy()) {
      for (const w of waiters) w();
      waiters = [];
    }
  }

  const busy = () => ending.size > 0 || [...open.values()].some((s) => s.queue.length > 0);

  function dropFile(s) {
    if (s.fd !== null) {
      try {
        fs.closeSync(s.fd);
      } catch (err) {
        // Already closed by an earlier failure; the file is removed below either way.
        log(`mic segment ${s.segment}: its file was already closed (${err?.code ?? "Error"})`);
      }
      s.fd = null;
    }
    if (s.partial) fs.rmSync(s.partial, { force: true });
    s.queue = [];
  }

  /** Give a whole segment its name and its row. */
  function finish(s, endAt) {
    // A hard link, then unlinking the partial: unlike rename, linking fails when the name is
    // taken, so a finished recording can never be replaced. The partial stays for the sweep.
    try {
      fs.linkSync(s.partial, s.final);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      return refuse(`segment ${s.segment}'s file name already exists; the earlier file is kept`);
    }
    fs.unlinkSync(s.partial);
    const row = { day: s.day, kind: "mic", path: `${s.day}/${s.name}`, start: s.start, end: endAt };
    const p = addSegment(row)
      .catch((err) =>
        // A Convex validation error echoes its arguments, so only its name is logged.
        log(`could not store a mic segment row for ${row.path} (${err?.name ?? "Error"}); the file stays until the retention sweep`)
      )
      .finally(() => pending.delete(p));
    pending.add(p);
    return { ok: true };
  }

  /** Check one message from the capture window and apply it. Never throws for bad input. */
  function handle(message) {
    if (closed) return refuse("the mic writer is closed");
    if (message === null || typeof message !== "object") return refuse("not a message");
    try {
      switch (message.type) {
        case "segmentStart":
          return begin(message.segment, message.start);
        case "chunk":
          return append(message.segment, message.bytes);
        case "chunkFailed":
          return lost(message.segment);
        case "segmentEnd":
          return end(message.segment, message.end);
        default:
          return refuse(`unknown message type ${JSON.stringify(String(message.type)).slice(0, 40)}`);
      }
    } catch (err) {
      // A disk error: the segment is lost, and the caller reports the mic as failed.
      return refuse(`could not write mic audio (${err?.code ?? err?.name ?? "Error"})`);
    }
  }

  /** Wait for row writes in flight, up to DRAIN_MS. */
  async function drain() {
    if (pending.size === 0) return;
    let timer;
    const done = await Promise.race([
      Promise.allSettled([...pending]).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), DRAIN_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!done) log(`${pending.size} mic segment row write(s) still pending after ${DRAIN_MS} ms`);
  }

  /** gs-capture's audio-use polls have looked at everything before `through`. */
  function classified(through) {
    if (closed || !isNum(through) || through <= classifiedThrough) return;
    classifiedThrough = through;
    catchUp();
  }

  /** Resolves once nothing waits for classification. */
  function settled() {
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  /**
   * A call started, or a never-record app is using audio: delete what waits and the open
   * segments, with no row, and write nothing more for this window. Up to one segment of audio
   * from before it is lost with them (plan.md Deviations, 4b).
   */
  function discardOpen() {
    discarding = true;
    for (const s of open.values()) {
      if (s.discarded) continue;
      dropFile(s);
      s.broken = true;
      s.discarded = true;
    }
    for (const { s } of ending.values()) dropFile(s);
    ending.clear();
    catchUp();
  }

  /**
   * Stop accepting messages. An unfinished segment stays a partial for the retention sweep;
   * what was never classified is dropped, not written: no poll can say a call wasn't in it.
   */
  async function close() {
    closed = true;
    for (const s of open.values()) {
      if (s.discarded) continue;
      if (s.queue.length > 0) log(`mic segment ${s.segment}: ${s.queue.length} chunk(s) not classified at close, dropped`);
      s.queue = [];
      fs.closeSync(s.fd);
    }
    open.clear();
    for (const [segment, { s }] of ending) {
      log(`mic segment ${segment} dropped at close: its end was not classified`);
      dropFile(s);
    }
    ending.clear();
    for (const w of waiters) w();
    waiters = [];
    await drain();
  }

  return { handle, drain, close, discardOpen, classified, settled };
}
