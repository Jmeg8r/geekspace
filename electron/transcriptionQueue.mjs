// WHAT: local transcription of Day Recorder segments (plan PR 5, spec R7). Closed segments are
// taken oldest first, one at a time, through whisper.cpp (meetingProcessor.transcribeFile),
// and each ends as a transcript row, as transcribed with nothing to say (silence, no speech),
// or as failed.
// WHY one at a time: whisper uses every core it is given, and a day's backlog must not make
// the Mac unusable; small.en runs at 0.03x realtime (spike Q6), so one keeps up easily.
// WHY no text in the log: transcripts are captured content (protocol.md), so a failure is
// logged with the segment id and the error's name only.
import { ToolMissingError } from "./meetingProcessor.mjs";

// After a missing tool or model, wait this long before trying again.
export const RETRY_AFTER_MS = 5 * 60_000;

export function createTranscriptionQueue({ transcribe, resolvePath, addTranscript, setSegmentStatus, log }) {
  // Segment ids taken this run (in progress or done), so a re-offered row is not redone.
  const taken = new Set();
  const waiting = [];
  let pausedUntil = 0;
  let stopped = false;
  let running = null;

  async function take(segment) {
    let file;
    try {
      file = resolvePath(segment.path);
    } catch (err) {
      log(`transcription: segment ${segment._id} refused (${err?.name ?? "Error"}: its path is not in the media root)`);
      await setSegmentStatus(segment._id, "failed");
      return;
    }
    let result;
    try {
      result = await transcribe(file);
    } catch (err) {
      if (err instanceof ToolMissingError) {
        pausedUntil = Date.now() + RETRY_AFTER_MS;
        log(`transcription paused: ${err.message}`);
        taken.delete(segment._id);
        return;
      }
      log(`transcription failed for segment ${segment._id} (${err?.name ?? "Error"})`);
      await setSegmentStatus(segment._id, "failed");
      return;
    }
    if ("transcript" in result) {
      await addTranscript({ segmentId: segment._id, start: segment.start, end: segment.end, text: result.transcript });
    } else {
      await setSegmentStatus(segment._id, "transcribed");
    }
  }

  async function pump() {
    while (!stopped && waiting.length > 0 && Date.now() >= pausedUntil) {
      const segment = waiting.shift();
      try {
        await take(segment);
      } catch (err) {
        // A row write failed (the backend is down): offered again next time, not lost.
        log(`transcription: could not store the result for segment ${segment._id} (${err?.name ?? "Error"})`);
        taken.delete(segment._id);
      }
    }
    // A pause leaves the rest waiting; they are offered again by the next update.
    if (Date.now() < pausedUntil) {
      for (const segment of waiting.splice(0)) taken.delete(segment._id);
    }
    running = null;
  }

  return {
    /** Closed segments as the backend lists them; new ones join the queue oldest first. */
    offer(segments) {
      if (stopped || Date.now() < pausedUntil) return;
      const fresh = segments.filter((s) => !taken.has(s._id));
      for (const s of fresh) taken.add(s._id);
      waiting.push(...fresh);
      waiting.sort((a, b) => a.start - b.start);
      if (!running) running = pump();
    },
    /** Resolves when nothing is running. */
    idle: () => running ?? Promise.resolve(),
    /** Start nothing new; the segment in progress finishes. */
    stop() {
      stopped = true;
      waiting.length = 0;
      return running ?? Promise.resolve();
    },
  };
}
