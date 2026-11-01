import { describe, expect, it, vi } from "vitest";
import { CALL_APPS, createCallDetector } from "../electron/callDetector.mjs";

// WHAT: call detection and the room-mic pause from the helper's audioUse lines (plan PR 4b).
// WHY tested: a call missed is a call recorded without notice (spec R5, F3), and a denylisted
// app heard through the room mic is the leak F2 closes. SYNTHETIC: bundle ids are real app
// ids, but no audio or content is involved.

type Use = { app: string | null; denylisted: boolean; input: boolean; output: boolean };
const use = (app: string | null, input: boolean, output = false, denylisted = false): Use => ({ app, denylisted, input, output });

function harness() {
  const onAppStarted = vi.fn();
  const onCallEnded = vi.fn();
  const onDenylistedAudio = vi.fn();
  const detector = createCallDetector({ onAppStarted, onCallEnded, onDenylistedAudio });
  return { detector, onAppStarted, onCallEnded, onDenylistedAudio };
}

describe("createCallDetector", () => {
  it("starts a call when a call app takes the mic, and ends it when it stops using audio", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", true, true));
    expect(h.onAppStarted).toHaveBeenCalledWith("us.zoom.xos");
    h.detector.receive(use("us.zoom.xos", false, false));
    expect(h.onCallEnded).toHaveBeenCalledOnce();
  });

  it("counts a browser holding the mic as a call (Meet and the like)", () => {
    const h = harness();
    h.detector.receive(use("com.google.Chrome", true));
    expect(h.onAppStarted).toHaveBeenCalledWith("com.google.Chrome");
  });

  it("does not count a browser's output alone, or an app that is not a call app", () => {
    const h = harness();
    h.detector.receive(use("com.google.Chrome", false, true));
    h.detector.receive(use("com.apple.VoiceMemos", true));
    expect(h.onAppStarted).not.toHaveBeenCalled();
  });

  // Codex 4b r1 P1: a listen-only call, and a call whose mic track stopped, are still calls.
  it("counts a dedicated call app's output alone as a call (listen-only)", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", false, true));
    expect(h.onAppStarted).toHaveBeenCalledWith("us.zoom.xos");
  });

  it("keeps a call going while the other side is still audible, after the mic is let go", () => {
    const h = harness();
    h.detector.receive(use("com.google.Chrome", true, true));
    h.detector.receive(use("com.google.Chrome", false, true));
    expect(h.onCallEnded).not.toHaveBeenCalled();
    h.detector.receive(use("com.google.Chrome", false, false));
    expect(h.onCallEnded).toHaveBeenCalledOnce();
  });

  // Codex 4b r2 P1: each app joining is reported, so a new app can't ride on an old answer.
  it("reports every call app that joins, and ends the call when the last one leaves", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", true));
    h.detector.receive(use("com.tinyspeck.slackmacgap", true));
    expect(h.onAppStarted.mock.calls).toEqual([["us.zoom.xos"], ["com.tinyspeck.slackmacgap"]]);
    h.detector.receive(use("us.zoom.xos", false));
    expect(h.onCallEnded).not.toHaveBeenCalled();
    h.detector.receive(use("com.tinyspeck.slackmacgap", false));
    expect(h.onCallEnded).toHaveBeenCalledOnce();
  });

  it("pauses the room mic while a denylisted app uses audio in or out (F2), and no call starts", () => {
    const h = harness();
    h.detector.receive(use(null, true, false, true));
    expect(h.onDenylistedAudio).toHaveBeenLastCalledWith(true);
    h.detector.receive(use(null, false, true, true));
    expect(h.onDenylistedAudio).toHaveBeenCalledTimes(1);
    h.detector.receive(use(null, false, false, true));
    expect(h.onDenylistedAudio).toHaveBeenLastCalledWith(false);
    expect(h.onAppStarted).not.toHaveBeenCalled();
  });

  // A new helper reports every app afresh; the notice treats it as a new start (Codex 4b r2).
  it("forgets everything on reset, quietly, and hears the new helper's report afresh", () => {
    const h = harness();
    h.detector.receive(use("us.zoom.xos", true));
    h.detector.receive(use(null, true, false, true));
    h.detector.reset();
    expect(h.onCallEnded).not.toHaveBeenCalled();
    h.detector.receive(use("us.zoom.xos", true));
    expect(h.onAppStarted).toHaveBeenCalledTimes(2);
    h.detector.receive(use(null, true, false, true));
    expect(h.onDenylistedAudio).toHaveBeenLastCalledWith(true);
  });

  it("covers the spec's call apps", () => {
    for (const id of ["com.apple.FaceTime", "us.zoom.xos", "com.microsoft.teams2", "com.tinyspeck.slackmacgap"]) {
      expect(CALL_APPS.has(id)).toBe(true);
    }
  });
});
