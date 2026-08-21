// WHAT: covers the recorder's device-resolution policy.
// WHY: these are the "the saved microphone is gone" paths this feature exists
// for — a silent substitution to the wrong input is exactly how a meeting gets
// recorded as 43 minutes of nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listMicrophones, openStream, resolveMicChoice } from "../src/lib/recorder";

type Track = { kind: string; label: string; stop: () => void };

function fakeStream(tracks: Track[] = []) {
  return { getTracks: () => tracks, getAudioTracks: () => tracks };
}

function stubMediaDevices(impl: {
  getUserMedia?: unknown;
  enumerateDevices?: unknown;
}) {
  vi.stubGlobal("navigator", { mediaDevices: impl });
}

/** DOMException-style error — only `name` distinguishes these in the browser. */
function namedError(name: string) {
  return Object.assign(new Error(name), { name });
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveMicChoice", () => {
  const MICS = [
    { deviceId: "yeti", label: "Yeti Stereo Microphone" },
    { deviceId: "pebble", label: "Creative Pebble X" },
  ];

  it("resolves a picked device", () => {
    expect(resolveMicChoice("yeti", MICS)).toEqual({
      deviceId: "yeti",
      label: "Yeti Stereo Microphone",
    });
  });

  it("returns empty strings for System default so the choice is persistable", () => {
    // WHY this matters: returning undefined here made the caller skip the save,
    // leaving a previously-saved device in settings. The next meeting's
    // preselection then restored it and recorded from the input the user had
    // just deselected -- the same silent substitution this feature prevents.
    expect(resolveMicChoice("", MICS)).toEqual({ deviceId: "", label: "" });
  });

  it("falls back to System default when the saved id is no longer present", () => {
    expect(resolveMicChoice("unplugged-device", MICS)).toEqual({ deviceId: "", label: "" });
  });

  it("returns System default when no devices are enumerated", () => {
    expect(resolveMicChoice("yeti", [])).toEqual({ deviceId: "", label: "" });
  });
});

describe("openStream", () => {
  it("requests the saved device exactly", async () => {
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    stubMediaDevices({ getUserMedia });

    expect(await openStream("dev-yeti")).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    expect((constraints.audio as MediaTrackConstraints).deviceId).toEqual({ exact: "dev-yeti" });
  });

  it("uses the system default when no device is saved", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream());
    stubMediaDevices({ getUserMedia });

    await openStream(undefined);
    const constraints = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    expect((constraints.audio as MediaTrackConstraints).deviceId).toBeUndefined();
  });

  it.each(["OverconstrainedError", "NotFoundError"])(
    "falls back to the system default on %s",
    async (errName) => {
      const fallback = fakeStream();
      const getUserMedia = vi
        .fn()
        .mockRejectedValueOnce(namedError(errName))
        .mockResolvedValueOnce(fallback);
      stubMediaDevices({ getUserMedia });

      expect(await openStream("dev-gone")).toBe(fallback);
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      const second = getUserMedia.mock.calls[1][0] as MediaStreamConstraints;
      expect((second.audio as MediaTrackConstraints).deviceId).toBeUndefined();
    }
  );

  it("propagates a permission denial instead of retrying on the default", async () => {
    // WHY: falling back here would turn "you denied the mic" into a second
    // failing prompt and hide the real reason recording never started.
    const getUserMedia = vi.fn().mockRejectedValue(namedError("NotAllowedError"));
    stubMediaDevices({ getUserMedia });

    await expect(openStream("dev-yeti")).rejects.toThrow("NotAllowedError");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("listMicrophones", () => {
  const mic = (deviceId: string, label: string) => ({ kind: "audioinput", deviceId, label });

  it("returns only audio inputs", async () => {
    stubMediaDevices({
      enumerateDevices: vi.fn().mockResolvedValue([
        mic("a", "Yeti Stereo Microphone"),
        { kind: "videoinput", deviceId: "cam", label: "FaceTime HD" },
        { kind: "audiooutput", deviceId: "spk", label: "Pebble X" },
      ]),
    });

    expect(await listMicrophones()).toEqual([
      { deviceId: "a", label: "Yeti Stereo Microphone" },
    ]);
  });

  it("probes for permission when labels are blank, then re-reads them", async () => {
    const stop = vi.fn();
    const probeTrack: Track = { kind: "audio", label: "", stop };
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([mic("a", ""), mic("b", "")])
      .mockResolvedValueOnce([mic("a", "Yeti Stereo Microphone"), mic("b", "Creative Pebble X")]);
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream([probeTrack]));
    stubMediaDevices({ enumerateDevices, getUserMedia });

    expect(await listMicrophones()).toEqual([
      { deviceId: "a", label: "Yeti Stereo Microphone" },
      { deviceId: "b", label: "Creative Pebble X" },
    ]);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // The probe must not leave the mic open — that shows a live recording indicator.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it("does not open a probe stream when labels are already present", async () => {
    const enumerateDevices = vi.fn().mockResolvedValue([mic("a", "Yeti Stereo Microphone")]);
    const getUserMedia = vi.fn();
    stubMediaDevices({ enumerateDevices, getUserMedia });

    await listMicrophones();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
  });

  it("names devices positionally when a label is still unavailable", async () => {
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([mic("a", "")])
      .mockResolvedValueOnce([mic("a", "")]);
    stubMediaDevices({
      enumerateDevices,
      getUserMedia: vi.fn().mockResolvedValue(fakeStream([{ kind: "audio", label: "", stop: vi.fn() }])),
    });

    expect(await listMicrophones()).toEqual([{ deviceId: "a", label: "Microphone 1" }]);
  });

  it("returns an empty list when the machine has no inputs", async () => {
    const getUserMedia = vi.fn();
    stubMediaDevices({ enumerateDevices: vi.fn().mockResolvedValue([]), getUserMedia });

    expect(await listMicrophones()).toEqual([]);
    // No devices means nothing to probe for — never prompt in that case.
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
