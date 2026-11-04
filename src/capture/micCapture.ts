// WHAT: the Day Recorder's mic segmenting (plan PR 3d-2, spec R2 and R3). Runs in the hidden
// capture window; the main process writes what it emits (electron/micSegments.mjs).
// WHY stop and restart at every boundary: timeslice chunks belong to one continuous WebM
// stream and only the first carries the container header, so one long recorder would leave
// every segment after the first undecodable on its own (Codex review of PR #70). The next
// recorder starts on the same stream before the old one finishes, so the gap is the time it
// takes to construct a MediaRecorder.
// WHY one emit queue: MediaRecorder hands over a Blob, and reading its bytes is async. Each
// chunk and each end marker is queued in order, so a segment's last chunk always reaches the
// main process before its segmentEnd.
// WHY a lost chunk drops its segment (Codex #89 r1): a chunk whose bytes cannot be read
// leaves a hole, so chunkFailed tells the writer to keep no file and no row for it, and the
// error says so out loud. A recorder that will not start is never announced as a segment.
import { SILENCE_LEVEL, SILENCE_WARN_SEC } from "../lib/recorder";

export type MicErrorKind = "denied" | "noDevice" | "unavailable" | "deviceLost" | "recorderError";

export type MicEvent =
  | { type: "segmentStart"; segment: number; start: number }
  | { type: "chunk"; segment: number; bytes: ArrayBuffer }
  | { type: "chunkFailed"; segment: number }
  | { type: "segmentEnd"; segment: number; end: number }
  | { type: "silent"; silentSec: number }
  | { type: "signal" }
  | { type: "error"; kind: MicErrorKind; message: string }
  | { type: "stopped" };

/** The slice of MediaRecorder this uses, so tests can drive it. */
export type RecorderLike = {
  start(timesliceMs: number): void;
  stop(): void;
  ondataavailable: ((e: { data: { size: number; arrayBuffer(): Promise<ArrayBuffer> } }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: { error?: { name?: string; message?: string } }) => void) | null;
};

/** The slice of MediaStream this uses. */
export type StreamLike = {
  getAudioTracks(): { addEventListener(type: "ended", fn: () => void): void }[];
};

export type MicCaptureOptions = {
  stream: StreamLike;
  createRecorder: (stream: StreamLike) => RecorderLike;
  segmentSec: number;
  timesliceMs: number;
  /** The current meter level, 0 to 1 (recorder.ts rmsLevel). */
  readLevel: () => number;
  emit: (event: MicEvent) => void;
  silenceWarnSec?: number;
  levelIntervalMs?: number;
};

const LEVEL_INTERVAL_MS = 1000;

/** Which kind of failure a getUserMedia rejection is, for the copy the user sees. */
export function micErrorKind(err: { name?: string }): MicErrorKind {
  if (err.name === "NotAllowedError" || err.name === "SecurityError") return "denied";
  if (err.name === "NotFoundError" || err.name === "OverconstrainedError") return "noDevice";
  return "unavailable";
}

export function startMicCapture({
  stream,
  createRecorder,
  segmentSec,
  timesliceMs,
  readLevel,
  emit,
  silenceWarnSec = SILENCE_WARN_SEC,
  levelIntervalMs = LEVEL_INTERVAL_MS,
}: MicCaptureOptions) {
  let queue = Promise.resolve();
  let current: { recorder: RecorderLike; segment: number } | null = null;
  let nextSegment = 0;
  let stopping = false;
  let finished: Promise<void> | null = null;
  let resolveFinished = () => {};
  // The segment whose end also ends the capture; a rolled-over recorder finishing late is not it.
  let finalSegment = -1;
  let lastSignalAt = Date.now();
  let warned = false;

  // Each step runs after the one before, even if that one failed; a failure is logged, and
  // the main process notices a window that stopped talking on its own.
  const enqueue = (step: () => void | Promise<void>) => {
    queue = queue.then(step).catch((err) => console.error("Day Recorder mic: could not send an event", err));
  };
  const send = (event: MicEvent) => enqueue(() => emit(event));

  function finish(segment: number) {
    send({ type: "segmentEnd", segment, end: Date.now() });
    if (segment !== finalSegment) return;
    send({ type: "stopped" });
    enqueue(resolveFinished);
  }

  /** Hand a recorder's events to this segment: its chunks in order, its stop, its failure. */
  function wire(recorder: RecorderLike, segment: number) {
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      const data = e.data;
      enqueue(async () => {
        let bytes: ArrayBuffer;
        try {
          bytes = await data.arrayBuffer();
        } catch (err) {
          console.error("Day Recorder mic: could not read a recorded chunk", err);
          emit({ type: "chunkFailed", segment });
          // Said in this step, ahead of any end marker already queued, and even during a stop:
          // the main process tears down on stopped, so a later error is never heard (Codex #89 r2).
          emit({ type: "error", kind: "recorderError", message: "A recorded chunk could not be read." });
          void stop();
          return;
        }
        emit({ type: "chunk", segment, bytes });
      });
    };
    recorder.onstop = () => finish(segment);
    recorder.onerror = (e) => {
      fail("recorderError", `The recorder failed (${e.error?.name ?? "Error"}).`);
    };
  }

  /** Start the next segment's recorder. False, and the failure reported, if it would not start. */
  function open(): boolean {
    const segment = nextSegment;
    let recorder: RecorderLike;
    try {
      recorder = createRecorder(stream);
      wire(recorder, segment);
      recorder.start(timesliceMs);
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      fail("recorderError", `The recorder could not start (${name}).`);
      return false;
    }
    nextSegment++;
    send({ type: "segmentStart", segment, start: Date.now() });
    current = { recorder, segment };
    return true;
  }

  function rollOver() {
    if (stopping || !current) return;
    const old = current.recorder;
    // A failed open has already stopped the capture, which finishes the old segment.
    if (open()) old.stop();
  }

  function fail(kind: MicErrorKind, message: string) {
    send({ type: "error", kind, message });
    // During a stop the error is still said (Codex #89 r3): Chromium can queue a failed
    // recorder's error behind a stop request. Only the stop itself is not asked for twice.
    if (!stopping) void stop();
  }

  const boundary = setInterval(rollOver, segmentSec * 1000);
  const meter = setInterval(() => {
    const now = Date.now();
    if (readLevel() > SILENCE_LEVEL) {
      lastSignalAt = now;
      if (warned) {
        warned = false;
        send({ type: "signal" });
      }
      return;
    }
    const silentSec = Math.floor((now - lastSignalAt) / 1000);
    if (!warned && silentSec >= silenceWarnSec) {
      warned = true;
      send({ type: "silent", silentSec });
    }
  }, levelIntervalMs);

  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => fail("deviceLost", "The microphone was disconnected."));
  }

  /** Finalize the open segment, then report stopped. Resolves once everything is sent. */
  function stop(): Promise<void> {
    if (finished) return finished;
    stopping = true;
    clearInterval(boundary);
    clearInterval(meter);
    finished = new Promise<void>((resolve) => (resolveFinished = resolve));
    const last = current;
    current = null;
    if (!last) {
      send({ type: "stopped" });
      enqueue(resolveFinished);
      return finished;
    }
    finalSegment = last.segment;
    try {
      last.recorder.stop();
    } catch (err) {
      // A recorder that already failed is inactive, and stop() throws instead of firing onstop.
      console.error("Day Recorder mic: the recorder could not be stopped", err);
      finish(last.segment);
    }
    return finished;
  }

  open();
  return { stop };
}
