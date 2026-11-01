// WHAT: call detection and the room-mic pause, from gs-capture's audioUse lines (plan PR 4b).
// A call is a call app or a browser holding the mic (spec, open question "Call-app list");
// a denylisted app using audio in or out pauses the room mic (spec F2).
// WHY a call continues on output (Codex review of PR 4b): a call whose mic track stopped is
// still audible, and a listen-only call never takes the mic. A dedicated call app playing
// audio is treated as a call; a browser only once it holds the mic, or every video would be.
// WHY a denylisted call app is no call: its audio is already excluded, and F2 pauses the mic
// for it, so there is nothing to give notice for.
// WHY a reset per helper (Codex review of PR 4b, round 2): a new helper reports every app using
// audio once, at start, and calls belong to one helper; the call notice asks again.

export const BROWSERS = new Set([
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
// The helper holds a call itself, by the same rule, so it is given both lists (Codex review of
// PR 4b, round 3).
export const DEDICATED_CALL_APPS = new Set([
  "com.apple.FaceTime",
  "us.zoom.xos",
  "com.microsoft.teams",
  "com.microsoft.teams2",
  "com.tinyspeck.slackmacgap",
  "Cisco-Systems.Spark",
]);
export const CALL_APPS = new Set([...DEDICATED_CALL_APPS, ...BROWSERS]);

export function createCallDetector({ onAppStarted, onCallEnded, onDenylistedAudio }) {
  // Call apps in a call now.
  const inCall = new Set();
  let denylisted = false;

  function setDenylisted(active) {
    if (active === denylisted) return;
    denylisted = active;
    onDenylistedAudio(active);
  }

  return {
    receive(use) {
      if (use.denylisted) {
        setDenylisted(use.input || use.output);
        return;
      }
      if (!use.app || !CALL_APPS.has(use.app)) return;
      const app = use.app;
      if (!use.input && !use.output) {
        if (inCall.delete(app) && inCall.size === 0) onCallEnded();
        return;
      }
      // Each app that joins is reported: a new app can't ride on an earlier answer.
      if (!inCall.has(app) && (use.input || !BROWSERS.has(app))) {
        inCall.add(app);
        onAppStarted(app);
      }
    },

    /** A new helper reports every app using audio afresh; nothing is announced for the old. */
    reset() {
      inCall.clear();
      denylisted = false;
    },
  };
}
