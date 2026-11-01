// WHAT: the Day Recorder's state copy (spec, UI states and copy), shared by the menu bar
// (dayRecorderTray.mjs) and the app's own indicator and Settings (plan PR 3e-2).
// WHY its own module: it imports nothing, so the renderer can load it too, and the tray and
// the app never describe the same state two ways.

export const SHORTCUT_TAKEN = " Another app is using ⌥⌘R, so pause and resume from this menu.";

// micController.mjs writes these kinds' errors as full sentences already.
const SENTENCE_KINDS = new Set(["denied", "windowGone", "noAudio", "cancelled"]);

/** A mic error as a sentence for people; the raw detail stays in the log. */
export function micErrorText(kind, error) {
  if (SENTENCE_KINDS.has(kind)) return error;
  if (kind === "protocol") return "The mic capture window sent something unexpected, so the mic stopped.";
  return `The mic recorder stopped with an error (${kind}: ${error}).`;
}

/** What a status looks like and says; null means nothing is shown. */
export function statusCopy(status, { shortcut }) {
  const view = stateCopy(status, shortcut);
  return view && !shortcut ? { ...view, tooltip: `${view.tooltip}${SHORTCUT_TAKEN}` } : view;
}

function stateCopy(status, shortcut) {
  switch (status.status) {
    case "recording": {
      const mic = status.mic;
      if (mic?.state === "silent") {
        return {
          tone: "amber",
          title: "Mic silent",
          tooltip: `No sound from the microphone for ${mic.silentSec} seconds. Check the input in System Settings → Sound, or pause recording.`,
          action: "pause",
        };
      }
      if (mic?.state === "error") {
        return {
          tone: "amber",
          title: "Recording without the mic",
          tooltip: `Recording without the mic. ${micErrorText(mic.kind, mic.error)} Screens and system audio are still recording.`,
          action: "pause",
        };
      }
      const tooltip = shortcut ? "Day Recorder is on. ⌥⌘R to pause." : "Day Recorder is on.";
      return { tone: "red", title: "Recording", tooltip, action: "pause" };
    }
    case "paused":
      return { tone: "hollow", title: "Paused", tooltip: "Recording paused. Resume when you're ready.", action: "resume" };
    case "starting":
      return { tone: "hollow", title: "Starting", tooltip: "Day Recorder is starting.", action: "pause" };
    case "stopping":
      return { tone: "hollow", title: "Stopping", tooltip: "Day Recorder is stopping.", action: "pause" };
    case "notRecording": {
      const retry = status.retryInMs ? ` Trying again in ${Math.round(status.retryInMs / 1000)} s.` : "";
      return { tone: "grey", title: "Not recording", tooltip: `${status.error}${retry}`, action: "pause" };
    }
    case "blocked":
      return { tone: "grey", title: "Not recording", tooltip: status.error, action: "pause" };
    default:
      return null;
  }
}
