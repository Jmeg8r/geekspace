// WHAT: call detection and the room-mic pause, from gs-capture's audioUse lines (plan PR 4b).
// A call is a call app or a browser holding the mic (spec, open question "Call-app list");
// a denylisted app using audio in or out pauses the room mic (spec F2).
// WHY input only for calls: a call app playing a notification sound is not a call; taking
// the mic is what every call does. WHY a denylisted call app is no call: its audio is
// already excluded, and F2 pauses the mic for it, so there is nothing to give notice for.

// Spike Q4 and spec: FaceTime, Zoom, Teams, Slack, plus any browser holding the mic. The
// helper maps a browser's helper process to the browser's own bundle id.
export const CALL_APPS = new Set([
  "com.apple.FaceTime",
  "us.zoom.xos",
  "com.microsoft.teams",
  "com.microsoft.teams2",
  "com.tinyspeck.slackmacgap",
  "Cisco-Systems.Spark",
  "com.google.Chrome",
  "com.apple.Safari",
  "org.mozilla.firefox",
  "company.thebrowser.Browser",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
]);

export function createCallDetector({ onCall, onDenylistedAudio }) {
  // Call apps holding the mic now, in the order they took it.
  const holding = new Set();
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
      const before = holding.size;
      if (use.input) holding.add(use.app);
      else holding.delete(use.app);
      if (before === 0 && holding.size > 0) onCall({ active: true, app: use.app });
      else if (before > 0 && holding.size === 0) onCall({ active: false, app: null });
    },
    /** A new helper reports every app from scratch; what the old one said no longer holds. */
    reset() {
      if (holding.size > 0) {
        holding.clear();
        onCall({ active: false, app: null });
      }
      setDenylisted(false);
    },
  };
}
