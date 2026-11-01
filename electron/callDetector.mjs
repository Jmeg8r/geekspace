// WHAT: call detection and the room-mic pause, from gs-capture's audioUse lines (plan PR 4b).
// A call is a call app or a browser holding the mic (spec, open question "Call-app list");
// a denylisted app using audio in or out pauses the room mic (spec F2).
// WHY a call continues on output (Codex review of PR 4b): a call whose mic track stopped is
// still audible, and a listen-only call never takes the mic. A dedicated call app playing
// audio is treated as a call; a browser only once it holds the mic, or every video would be.
// WHY a denylisted call app is no call: its audio is already excluded, and F2 pauses the mic
// for it, so there is nothing to give notice for.
// WHY a snapshot on restart: a new helper reports every app using audio once, at start. What
// it reports again is the same call; what it doesn't has stopped. Forgetting everything would
// turn a declined call into a new one.

const BROWSERS = new Set([
  "com.google.Chrome",
  "com.apple.Safari",
  "org.mozilla.firefox",
  "company.thebrowser.Browser",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
]);

// Spike Q4 and spec: FaceTime, Zoom, Teams, Slack, plus any browser holding the mic. The
// helper maps a browser's helper process to the browser's own bundle id.
export const CALL_APPS = new Set([
  "com.apple.FaceTime",
  "us.zoom.xos",
  "com.microsoft.teams",
  "com.microsoft.teams2",
  "com.tinyspeck.slackmacgap",
  "Cisco-Systems.Spark",
  ...BROWSERS,
]);

export function createCallDetector({ onCall, onDenylistedAudio }) {
  // Call apps in a call now.
  const inCall = new Set();
  let denylisted = false;
  // While a new helper's first report is coming in: what it reported.
  let snapshot = null;

  function setDenylisted(active) {
    if (active === denylisted) return;
    denylisted = active;
    onDenylistedAudio(active);
  }

  function update(app, change) {
    const before = inCall.size;
    change();
    if (before === 0 && inCall.size > 0) onCall({ active: true, app });
    else if (before > 0 && inCall.size === 0) onCall({ active: false, app: null });
  }

  return {
    receive(use) {
      if (use.denylisted) {
        if (snapshot) snapshot.denylisted = use.input || use.output;
        setDenylisted(use.input || use.output);
        return;
      }
      if (!use.app || !CALL_APPS.has(use.app)) return;
      const app = use.app;
      snapshot?.apps.add(app);
      update(app, () => {
        if (!use.input && !use.output) inCall.delete(app);
        else if (use.input || !BROWSERS.has(app)) inCall.add(app);
      });
    },

    /** A new helper is starting: its first report says what is still going on. */
    beginSnapshot() {
      snapshot = { apps: new Set(), denylisted: false };
    },

    /** The first report is in: apps it did not mention have stopped. */
    endSnapshot() {
      if (!snapshot) return;
      const seen = snapshot;
      snapshot = null;
      for (const app of [...inCall]) {
        if (!seen.apps.has(app)) update(null, () => inCall.delete(app));
      }
      if (!seen.denylisted) setDenylisted(false);
    },
  };
}
