import { describe, expect, it } from "vitest";
import { SHORTCUT_TAKEN as TRAY_SHORTCUT_TAKEN, trayView } from "../electron/dayRecorderTray.mjs";
import { SHORTCUT_TAKEN, micErrorText, statusCopy } from "../electron/dayRecorderCopy.mjs";

// WHAT: the Day Recorder's state copy, shared by the menu bar and the app (plan PR 3e-2).
// WHY one module: the tray and the app chrome must never describe the same state two ways,
// and this module has no Node imports, so the renderer can load it too.

describe("statusCopy", () => {
  it("is what the tray shows", () => {
    expect(trayView).toBe(statusCopy);
    expect(TRAY_SHORTCUT_TAKEN).toBe(SHORTCUT_TAKEN);
  });

  it("describes a mic error in a full sentence, whatever the error was", () => {
    const v = statusCopy(
      { status: "recording", mic: { state: "error", kind: "protocol", error: "the capture window sent a malformed silence report" } },
      { shortcut: true }
    );
    expect(v?.tooltip).toBe(
      "Recording without the mic. The mic capture window sent something unexpected, so the mic stopped. Screens and system audio are still recording."
    );
  });
});

describe("micErrorText", () => {
  it("keeps the mic controller's own sentences", () => {
    const denied = "Microphone access is off for Geekspace. Turn it on in System Settings > Privacy & Security > Microphone.";
    expect(micErrorText("denied", denied)).toBe(denied);
    expect(micErrorText("windowGone", "The mic capture window stopped unexpectedly.")).toBe(
      "The mic capture window stopped unexpectedly."
    );
    expect(micErrorText("noAudio", "The microphone delivered no audio for a whole segment.")).toBe(
      "The microphone delivered no audio for a whole segment."
    );
  });

  it("puts a protocol fault in plain words", () => {
    expect(micErrorText("protocol", "the capture window sent a message that was refused (size)")).toBe(
      "The mic capture window sent something unexpected, so the mic stopped."
    );
  });

  it("names a recorder error from the page, in a sentence", () => {
    expect(micErrorText("NotReadableError", "Could not start audio source")).toBe(
      "The mic recorder stopped with an error (NotReadableError: Could not start audio source)."
    );
  });
});

// Plan PR 4b, spec UI table: "Call held | amber + Call — not saved yet".
describe("statusCopy, a call waiting for its notice", () => {
  it("says the call is not saved yet, in amber, and what to do", () => {
    expect(statusCopy({ status: "recording", call: "held" }, { shortcut: true })).toEqual({
      tone: "amber",
      title: "Call — not saved yet",
      tooltip: "Tell everyone on this call it's being recorded and transcribed. Then choose I told them in Geekspace.",
      action: "pause",
    });
  });
});
