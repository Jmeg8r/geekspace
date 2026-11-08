// WHAT: the Day Recorder's auto-stop (plan PR 7, James 2026-11-07). With an end time set, a
// recorder that is on when that time or local midnight comes turns off. Only time spent on
// counts, so a deliberate start after the end time runs until midnight; sleep that crossed a
// stop moment stops it at wake.
// WHY it can only stop: the one action it is given is a stop. The schedule never turns
// capture on; starting is always James's own act.

const MINUTES_PER_HOUR = 60;

/**
 * The first stop moment in (since, now] — each local day's end time, and each local midnight
 * — or null when there is none or no end time is set. Local wall-clock time, so 18:00 stays
 * 18:00 across a DST change.
 */
export function stopDue({ stopAtMin, since, now }) {
  if (stopAtMin === null || now <= since) return null;
  const hour = Math.floor(stopAtMin / MINUTES_PER_HOUR);
  const minute = stopAtMin % MINUTES_PER_HOUR;
  const first = new Date(since);
  let best = null;
  for (let day = new Date(first.getFullYear(), first.getMonth(), first.getDate()); day.getTime() <= now; ) {
    const endTime = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
    const midnight = day.getTime();
    for (const [moment, reason] of [
      [midnight, "midnight"],
      [endTime, "endTime"],
    ]) {
      if (moment > since && moment <= now && (best === null || moment < best.at)) best = { at: moment, reason };
    }
    if (best) return best;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return best;
}

/**
 * Tracks the recorder's on time and stops it when a stop moment passes. `update` takes each
 * settings change; `check` runs on a timer and on wake. `stop` is given the session it is to
 * end. A stop that throws leaves the span as it was, so the next check tries again.
 */
export function createAutoStop({ now, stop }) {
  let enabled = false;
  let stopAtMin = null;
  let session = null;
  // The start of the on time not yet checked: null while off.
  let since = null;
  let checking = false;

  function update(settings) {
    // A new session is a fresh start even when the off between never reached us.
    if (settings.enabled && (!enabled || settings.session !== session)) since = now();
    if (!settings.enabled) since = null;
    enabled = settings.enabled;
    stopAtMin = settings.stopAtMin;
    session = settings.session;
  }

  async function check() {
    // One at a time: the timer and a wake can arrive together, and one stop is enough.
    if (checking) return;
    checking = true;
    try {
      const t = now();
      if (!enabled || stopAtMin === null || since === null) {
        since = enabled ? t : null;
        return;
      }
      const due = stopDue({ stopAtMin, since, now: t });
      if (!due) {
        since = t;
        return;
      }
      const ending = session;
      await stop(due, ending);
      // A restart while the stop was out is a new session with its own on time: keep it.
      if (session === ending) since = null;
    } finally {
      checking = false;
    }
  }

  return { update, check };
}
