// WHAT: local transcription of Day Recorder segments (plan PR 5, spec R7). Closed segments are
// taken oldest first, one at a time, through whisper.cpp (meetingProcessor.transcribeFile),
// and each ends as a transcript row, as transcribed with nothing to say (silence, no speech),
// or as failed.
// WHY one at a time: whisper uses every core it is given, and a day's backlog must not make
// the Mac unusable; small.en runs at 0.03x realtime (spike Q6), so one keeps up easily.
// WHY no text in the log: transcripts are captured content (protocol.md), so a failure is
// logged with the segment id and the error's name only.
// WHY it retries on its own (Codex review of PR 5): the backend lists what is waiting by
// subscription, which says nothing new while the list is unchanged. A missing tool and a
// backend that was down are both retried on a timer, and a result already made is kept, not
// transcribed again.
// WHY stop waits only so long (Codex review of PR 5, round 3): a disconnected Convex client
// keeps a mutation pending instead of failing it, so a row write could hold quit forever. The
// segment is still closed in the backend until its row is in, so the next start takes it again;
// and a write that did land is not added twice (dayRecorder.addTranscript).
import { ToolMissingError } from "./meetingProcessor.mjs";

// After a missing tool or model, or a failed row write, wait this long before trying again.
export const RETRY_AFTER_MS = 5 * 60_000;
// How long stop waits for the segment in progress: longer than small.en takes for one segment
// (about 9 s for 5 minutes of audio, spike Q6) plus its row write.
export const STOP_GRACE_MS = 30_000;

export function createTranscriptionQueue({ transcribe, resolvePath, addTranscript, setSegmentStatus, log }) {
  // Every segment id this run has taken: waiting, in progress, or done.
  const known = new Set();
  /** Oldest first: { segment, result? }; `result` is kept when its write failed. */
  const waiting = [];
  let pausedUntil = 0;
  let stopped = false;
  let running = null;
  // The item being worked on, for the log when stop gives up on it.
  let active = null;
  let retryTimer = null;

  function scheduleRetry() {
    if (retryTimer || stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      kick();
    }, RETRY_AFTER_MS);
  }

  function kick() {
    if (running || stopped || waiting.length === 0 || Date.now() < pausedUntil) return;
    running = pump().finally(() => {
      running = null;
    });
  }

  /** What became of the segment: transcribe it unless it already has a result, then store. */
  async function take(item) {
    const { segment } = item;
    if (!item.result) {
      let file;
      try {
        file = resolvePath(segment.path);
      } catch (err) {
        log(`transcription: segment ${segment._id} refused (${err?.name ?? "Error"}: its path is not in the media root)`);
        item.result = { status: "failed" };
      }
      if (file) {
        try {
          item.result = await transcribe(file);
        } catch (err) {
          if (err instanceof ToolMissingError) {
            log(`transcription paused: ${err.message}`);
            return "pause";
          }
          log(`transcription failed for segment ${segment._id} (${err?.name ?? "Error"})`);
          item.result = { status: "failed" };
        }
      }
    }
    try {
      if ("transcript" in item.result) {
        await addTranscript({ segmentId: segment._id, start: segment.start, end: segment.end, text: item.result.transcript });
      } else {
        await setSegmentStatus(segment._id, item.result.status ?? "transcribed");
      }
    } catch (err) {
      log(`transcription: could not store the result for segment ${segment._id} (${err?.name ?? "Error"}); trying again later`);
      return "retry";
    }
    return "done";
  }

  async function pump() {
    while (!stopped && waiting.length > 0 && Date.now() >= pausedUntil) {
      // Out of the list while it runs, so an offer that re-sorts the list can't displace it
      // (Codex review of PR 5, round 2).
      const item = waiting.shift();
      active = item;
      const outcome = await take(item);
      active = null;
      if (outcome === "done") continue;
      // Back in its place, to be tried again.
      waiting.push(item);
      waiting.sort((a, b) => a.segment.start - b.segment.start);
      if (outcome === "pause") pausedUntil = Date.now() + RETRY_AFTER_MS;
      scheduleRetry();
      return;
    }
  }

  return {
    /** Closed segments as the backend lists them; new ones join the queue, oldest first. */
    offer(segments) {
      if (stopped) return;
      for (const segment of segments) {
        if (known.has(segment._id)) continue;
        known.add(segment._id);
        waiting.push({ segment });
      }
      waiting.sort((a, b) => a.segment.start - b.segment.start);
      kick();
    },
    /** Resolves when nothing is running. */
    idle: () => running ?? Promise.resolve(),
    /** Start nothing new; the segment in progress gets STOP_GRACE_MS to finish. */
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      waiting.length = 0;
      const current = running;
      if (!current) return Promise.resolve();
      return new Promise((resolve) => {
        const grace = setTimeout(() => {
          log(`transcription: segment ${active?.segment._id ?? "(unknown)"} was not finished at stop; it stays closed and is taken again at the next start`);
          resolve();
        }, STOP_GRACE_MS);
        void current.finally(() => {
          clearTimeout(grace);
          resolve();
        });
      });
    },
  };
}
