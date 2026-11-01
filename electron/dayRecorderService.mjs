// WHAT: turns the Day Recorder settings into a running gs-capture helper (plan PR 3c).
// Before every start it runs the FileVault and Time Machine gates (spec F7, F8). A denylist
// or interval change restarts the helper, because the helper reads its arguments once
// (protocol.md). Capture failures are recorded as capError events. The retention purge runs
// when the service is created and then every PURGE_INTERVAL_MS for its whole life, whether
// or not capture is on or settings ever arrive: media recorded once still has to go after
// 30 days (R14). Settings govern capture only. A saved pause (plan PR 3d-1) stops the helper
// but leaves the recorder enabled, so it holds across a relaunch.
// WHY one queue: settings can change while a start is still running its gates; applying
// them one at a time means two helpers never run at once.

// Spec R2's SEGMENT_SEC default. Not a setting in v1.
export const SEGMENT_SEC = 300;
// recorderEvents.detail's limit (dayRecorder.logEvent).
const MAX_DETAIL_CHARS = 2000;
// R14 asks for a daily purge. Running more often costs one indexed query and keeps a
// laptop that sleeps through the run from skipping a day.
export const PURGE_INTERVAL_MS = 6 * 3_600_000;
// A helper that exited or went silent is retried after these delays, then left Not
// recording. A permission, spawn or protocol failure is never retried: retrying can't fix
// it, and a loop would only hide it.
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
// A run that stays recording this long earns a fresh retry budget.
export const RETRY_RESET_MS = 10 * 60_000;
// The helper's own permission message says "permission"; a native ScreenCaptureKit denial
// says "declined TCCs" (spike-findings.md, Q7) and is passed through as-is.
const PERMISSION_RE = /permission|declined TCC/i;

export function createDayRecorderService({
  platform,
  mediaRoot,
  helperPath,
  gates,
  createSupervisor,
  convex,
  purge,
  log,
  purgeIntervalMs = PURGE_INTERVAL_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  retryResetMs = RETRY_RESET_MS,
  // Whether a new helper must hold call audio from its first sample (plan PR 4b).
  callHeldAtStart = () => false,
  // Runs before a helper is stopped, while it is still the current one (plan PR 4b): the mic
  // finishes while the helper that classifies its audio still runs (Codex #4b r5).
  beforeHelperStop = async () => {},
}) {
  let status = { status: "off" };
  let supervisor = null;
  // The supervisor being stopped: its state changes still count, and killSync still reaches it.
  let stopping = null;
  let runningKey = null;
  let latest = null;
  let queue = Promise.resolve();
  let purgeTimer = null;
  let purging = false;
  let closed = false;
  let retries = 0;
  let retryTimer = null;
  let recordingSince = null;
  // The mic's own state (micController.mjs). It rides on Recording only: the mic degrades on
  // its own (James, 2026-10-31), so Recording with a mic error is still Recording.
  let mic = null;
  const listeners = new Set();
  const audioUseListeners = new Set();
  const audioReadyListeners = new Set();
  const callHeldListeners = new Set();
  const classifiedListeners = new Set();

  function live() {
    if (!supervisor) throw new Error("The capture helper is not running");
    return supervisor;
  }

  function setStatus(next) {
    status = next.status === "recording" && mic ? { ...next, mic } : next;
    for (const cb of listeners) cb(status);
  }

  function recordError(detail) {
    convex.logEvent({ kind: "capError", detail: detail.slice(0, MAX_DETAIL_CHARS) }).catch((err) =>
      log(`could not record a capError event (${err?.name ?? "Error"})`)
    );
  }

  function runPurge() {
    if (purging || closed) return;
    purging = true;
    purge()
      .catch((err) => log(`purge failed: ${err?.message ?? err}`))
      .finally(() => {
        purging = false;
      });
  }

  function scheduleRetention() {
    // There is no media root off macOS, so nothing to purge either.
    if (purgeTimer || closed || platform !== "darwin") return;
    runPurge();
    purgeTimer = setInterval(runPurge, purgeIntervalMs);
    // Retention never keeps the process alive on its own; the app's lifetime decides.
    purgeTimer.unref?.();
  }

  async function stopCurrent() {
    if (!supervisor) return;
    try {
      await beforeHelperStop();
    } catch (err) {
      log(`before stopping the helper: ${err?.message ?? err}`);
    }
    if (!supervisor) return;
    const old = supervisor;
    supervisor = null;
    runningKey = null;
    stopping = old;
    try {
      await old.stop();
    } finally {
      if (stopping === old) stopping = null;
    }
  }

  function cancelRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function onFailure(error) {
    if (recordingSince !== null && Date.now() - recordingSince >= retryResetMs) retries = 0;
    recordingSince = null;
    recordError(`${error.reason}: ${error.message}`);
    const retryable =
      (error.reason === "exited" || error.reason === "silent") && !PERMISSION_RE.test(error.message);
    if (!retryable || closed || !latest?.enabled || latest.paused) {
      setStatus({ status: "notRecording", error: error.message });
      return;
    }
    if (retries >= retryDelaysMs.length) {
      setStatus({ status: "notRecording", error: error.message });
      recordError(`no more retries after ${retryDelaysMs.length}; turn the recorder off and on to try again`);
      return;
    }
    const delay = retryDelaysMs[retries++];
    setStatus({ status: "notRecording", error: error.message, retryInMs: delay });
    recordError(`retry ${retries} of ${retryDelaysMs.length} in ${Math.round(delay / 1000)} s`);
    cancelRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      enqueue();
    }, delay);
  }

  function onSupervisorState(owner, s) {
    if (owner !== supervisor && owner !== stopping) return;
    if (s.status === "notRecording") {
      onFailure(s.error);
      return;
    }
    if (s.status === "recording") recordingSince ??= Date.now();
    setStatus({ status: s.status });
  }

  async function applyNow() {
    const s = latest;
    if (closed || !s) return;
    // After every await below: a newer apply is already queued and takes over, or shutdown
    // has begun. Either way this one must not go on to start a helper.
    const superseded = () => closed || latest !== s;
    if (!s.enabled || s.paused) {
      await stopCurrent();
      if (!closed) setStatus({ status: s.enabled ? "paused" : "off" });
      return;
    }
    if (platform !== "darwin") {
      // gs-capture is a macOS helper and v1 is Mac Studio only (spec).
      if (status.status !== "unsupported") log("Day Recorder is macOS-only in v1; not starting");
      setStatus({ status: "unsupported" });
      return;
    }
    const denylist = [...new Set(s.denylist)];
    const key = JSON.stringify([denylist, s.shotSec]);
    const live = supervisor?.state().status;
    if (key === runningKey && (live === "starting" || live === "recording")) return;

    await stopCurrent();
    if (superseded()) return;
    setStatus({ status: "starting" });
    for (const gate of [gates.fileVault, () => gates.backupExclusion(mediaRoot)]) {
      const result = await gate();
      if (superseded()) return;
      if (!result.ok) {
        log(`Day Recorder blocked: ${result.error}`);
        setStatus({ status: "blocked", error: result.error });
        recordError(`gate: ${result.error}`);
        return;
      }
    }
    const owner = createSupervisor({
      command: helperPath,
      mediaRoot,
      sink: { addScreenshot: convex.addScreenshot, addSegment: convex.addSegment },
      log,
      onState: (st) => onSupervisorState(owner, st),
      onAudioUse: (m) => {
        if (owner !== supervisor) return;
        for (const cb of audioUseListeners) cb(m);
      },
      onAudioUseReady: () => {
        if (owner !== supervisor) return;
        for (const cb of audioReadyListeners) cb();
      },
      onCallHeld: (app) => {
        if (owner !== supervisor) return;
        for (const cb of callHeldListeners) cb(app);
      },
      onAudioClassified: (through) => {
        if (owner !== supervisor) return;
        for (const cb of classifiedListeners) cb(through);
      },
    });
    supervisor = owner;
    runningKey = key;
    try {
      const startHeld = callHeldAtStart();
      owner.start({ denylist, shotSec: s.shotSec, segmentSec: SEGMENT_SEC, ...(startHeld && { startHeld }) });
    } catch (err) {
      supervisor = null;
      runningKey = null;
      const message = err?.message ?? String(err);
      setStatus({ status: "notRecording", error: message });
      recordError(`start: ${message}`);
    }
  }

  function enqueue() {
    queue = queue.then(applyNow, applyNow).catch((err) => log(`Day Recorder could not apply settings: ${err?.message ?? err}`));
    return queue;
  }

  /**
   * Apply settings; overlapping calls queue, and each applies the newest settings. A
   * settings change also cancels a pending retry and resets the retry budget.
   */
  function apply(settings) {
    latest = settings;
    cancelRetry();
    retries = 0;
    return enqueue();
  }

  async function shutdown() {
    closed = true;
    cancelRetry();
    await queue;
    clearInterval(purgeTimer);
    purgeTimer = null;
    await stopCurrent();
    setStatus({ status: "off" });
  }

  scheduleRetention();

  return {
    apply,
    shutdown,
    status: () => status,
    setMic(next) {
      if (JSON.stringify(next) === JSON.stringify(mic)) return;
      mic = next;
      if (status.status === "recording") setStatus({ status: "recording" });
    },
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onAudioUse(cb) {
      audioUseListeners.add(cb);
      return () => audioUseListeners.delete(cb);
    },
    onAudioUseReady(cb) {
      audioReadyListeners.add(cb);
      return () => audioReadyListeners.delete(cb);
    },
    /** The live helper held a call app's audio on its own (plan PR 4b). */
    onCallHeld(cb) {
      callHeldListeners.add(cb);
      return () => callHeldListeners.delete(cb);
    },
    /** How far the live helper's audio-use polls have classified (plan PR 4b). */
    onAudioClassified(cb) {
      classifiedListeners.add(cb);
      return () => classifiedListeners.delete(cb);
    },
    /** The call hold, on the live helper (plan PR 4b). Throws when none is running. */
    calls: {
      hold: () => live().holdCall(),
      release: (noticeEventId) => live().releaseCall(noticeEventId),
      discard: () => live().discardCall(),
      clear: () => live().clearCall(),
    },
    running: () => supervisor?.running() ?? false,
    killSync() {
      supervisor?.killSync();
      stopping?.killSync();
    },
  };
}

/**
 * The before-quit hold for the Day Recorder. The first quit starts the stop; every quit
 * until it finishes is held (so the backend stays up for the final segment's row), and one
 * quit follows. Returns whether this quit was held.
 */
export function createQuitHold({ stop, quit, log }) {
  let stopped = null;
  let done = false;
  return (event) => {
    if (done) return false;
    event.preventDefault();
    // An async wrapper calls stop now and turns a synchronous throw into a rejection.
    stopped ??= (async () => stop())()
      .catch((err) => log(`Day Recorder did not stop cleanly: ${err?.message ?? err}`))
      .finally(() => {
        done = true;
        quit();
      });
    return true;
  };
}
