// WHAT: turns the Day Recorder settings into a running gs-capture helper (plan PR 3c).
// Before every start it runs the FileVault and Time Machine gates (spec F7, F8). A denylist
// or interval change restarts the helper, because the helper reads its arguments once
// (protocol.md). Capture failures are recorded as capError events, and the retention purge
// runs when recording starts and then every PURGE_INTERVAL_MS.
// WHY one queue: settings can change while a start is still running its gates; applying
// them one at a time means two helpers never run at once.

// Spec R2's SEGMENT_SEC default. Not a setting in v1.
export const SEGMENT_SEC = 300;
// recorderEvents.detail's limit (dayRecorder.logEvent).
const MAX_DETAIL_CHARS = 2000;
// R14 asks for a daily purge. Running more often costs one indexed query and keeps a
// laptop that sleeps through the run from skipping a day.
export const PURGE_INTERVAL_MS = 6 * 3_600_000;

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
}) {
  let status = { status: "off" };
  let supervisor = null;
  let runningKey = null;
  let latest = null;
  let queue = Promise.resolve();
  let purgeTimer = null;
  let purging = false;
  let closed = false;
  const listeners = new Set();

  function setStatus(next) {
    status = next;
    for (const cb of listeners) cb(next);
  }

  function recordError(detail) {
    convex.logEvent({ kind: "capError", detail: detail.slice(0, MAX_DETAIL_CHARS) }).catch((err) =>
      log(`could not record a capError event (${err?.name ?? "Error"})`)
    );
  }

  function runPurge() {
    if (purging) return;
    purging = true;
    purge()
      .catch((err) => log(`purge failed: ${err?.message ?? err}`))
      .finally(() => {
        purging = false;
      });
  }

  async function stopCurrent() {
    if (!supervisor) return;
    const old = supervisor;
    supervisor = null;
    runningKey = null;
    await old.stop();
  }

  function onSupervisorState(owner, s) {
    if (owner !== supervisor) return;
    if (s.status === "notRecording") {
      setStatus({ status: "notRecording", error: s.error.message });
      recordError(`${s.error.reason}: ${s.error.message}`);
    } else {
      setStatus({ status: s.status });
    }
  }

  async function applyNow() {
    const s = latest;
    if (closed || !s) return;
    if (!s.enabled) {
      clearInterval(purgeTimer);
      purgeTimer = null;
      await stopCurrent();
      setStatus({ status: "off" });
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
    for (const gate of [gates.fileVault, () => gates.backupExclusion(mediaRoot)]) {
      const result = await gate();
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
    });
    supervisor = owner;
    runningKey = key;
    try {
      owner.start({ denylist, shotSec: s.shotSec, segmentSec: SEGMENT_SEC });
    } catch (err) {
      supervisor = null;
      runningKey = null;
      const message = err?.message ?? String(err);
      setStatus({ status: "notRecording", error: message });
      recordError(`start: ${message}`);
      return;
    }
    runPurge();
    purgeTimer ??= setInterval(runPurge, purgeIntervalMs);
  }

  /** Apply settings; overlapping calls queue, and each applies the newest settings. */
  function apply(settings) {
    latest = settings;
    queue = queue.then(applyNow, applyNow).catch((err) => log(`Day Recorder could not apply settings: ${err?.message ?? err}`));
    return queue;
  }

  async function shutdown() {
    closed = true;
    clearInterval(purgeTimer);
    purgeTimer = null;
    await queue;
    await stopCurrent();
  }

  return {
    apply,
    shutdown,
    status: () => status,
    onStatus(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    running: () => supervisor?.running() ?? false,
    killSync: () => supervisor?.killSync(),
  };
}
