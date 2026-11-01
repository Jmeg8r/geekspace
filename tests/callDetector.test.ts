import { describe, expect, it, vi } from "vitest";
import { CALL_APPS, createCallDetector } from "../electron/callDetector.mjs";

// WHAT: call detection and the room-mic pause from the helper's audioUse lines (plan PR 4b).
// WHY tested: a call missed is a call recorded without notice (spec R5, F3), and a denylisted
// app heard through the room mic is the leak F2 closes. SYNTHETIC: bundle ids are real app
// ids, but no audio or content is involved.

type Use = { app: string | null; denylisted: boolean; input: boolean; output: boolean };
const use = (app: string | null, input: boolean, output = false, denylisted = false): Use => ({ app, denylisted, input, output });

function harness() {
  const onCall = vi.fn();
  const onDenylistedAudio = vi.fn();
  const detector = createCallDetector({ onCall, onDenylistedAudio });
  return { detector, onCall, onDenylistedAudio };
}

describe("createCallDetector", () => {
  it("starts a call when a call app takes the mic, and ends it when it lets go", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", true, true));
    expect(h.onCall).toHaveBeenLastCalledWith({ active: true, app: "us.zoom.xos" });
    h.detector.receive(use("us.zoom.xos", false, true));
    expect(h.onCall).toHaveBeenLastCalledWith({ active: false, app: null });
    expect(h.onCall).toHaveBeenCalledTimes(2);
  });

  it("counts a browser holding the mic as a call (Meet and the like)", () => {
    const h = harness();
    h.detector.receive(use("com.google.Chrome", true));
    expect(h.onCall).toHaveBeenLastCalledWith({ active: true, app: "com.google.Chrome" });
  });

  it("does not count output alone, or an app that is not a call app", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", false, true));
    h.detector.receive(use("com.apple.VoiceMemos", true));
    expect(h.onCall).not.toHaveBeenCalled();
  });

  it("keeps one call while a second call app joins, and ends it when the last leaves", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", true));
    h.detector.receive(use("com.tinyspeck.slackmacgap", true));
    h.detector.receive(use("us.zoom.xos", false));
    expect(h.onCall).toHaveBeenCalledTimes(1);
    h.detector.receive(use("com.tinyspeck.slackmacgap", false));
    expect(h.onCall).toHaveBeenLastCalledWith({ active: false, app: null });
  });

  it("pauses the room mic while a denylisted app uses audio in or out (F2), and no call starts", () => {
    const h = harness();
    h.detector.receive(use(null, true, false, true));
    expect(h.onDenylistedAudio).toHaveBeenLastCalledWith(true);
    h.detector.receive(use(null, false, true, true));
    expect(h.onDenylistedAudio).toHaveBeenCalledTimes(1);
    h.detector.receive(use(null, false, false, true));
    expect(h.onDenylistedAudio).toHaveBeenLastCalledWith(false);
    expect(h.onCall).not.toHaveBeenCalled();
  });

  it("forgets everything on reset, as a new helper reports from scratch", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", true));
    h.detector.receive(use(null, true, false, true));
    h.detector.reset();
    expect(h.onCall).toHaveBeenLastCalledWith({ active: false, app: null });
    expect(h.onDenylistedAudio).toHaveBeenLastCalledWith(false);
    h.detector.receive(use("us.zoom.xos", true));
    expect(h.onCall).toHaveBeenLastCalledWith({ active: true, app: "us.zoom.xos" });
  });

  it("covers the spec's call apps", () => {
    for (const id of ["com.apple.FaceTime", "us.zoom.xos", "com.microsoft.teams2", "com.tinyspeck.slackmacgap"]) {
      expect(CALL_APPS.has(id)).toBe(true);
    }
  });
});
