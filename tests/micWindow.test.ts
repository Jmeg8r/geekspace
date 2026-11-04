import { describe, expect, it, vi } from "vitest";
import type { MicEvent } from "../src/capture/micCapture";
import { runMicWindow, type CaptureBridge, type MicConfig, type OpenedMic } from "../src/capture/micWindow";

// WHAT: the hidden capture window's startup (plan PR 3d-2): read the config, open the mic,
// start capture. WHY tested: Codex #89 r1 (P1) found that a stop landing during startup was
// lost, so capture started anyway until the main process destroyed the window. A stop at any
// point must start nothing, let go of the mic, and still say stopped.

const CFG: MicConfig = { segmentSec: 300, timesliceMs: 1000 };

type ConfigReply = Awaited<ReturnType<CaptureBridge["config"]>>;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function harness(opts: { config?: Promise<ConfigReply>; mic?: Promise<OpenedMic> } = {}) {
  const events: MicEvent[] = [];
  let stopCb: (() => void) | null = null;
  const api: CaptureBridge = {
    config: () => opts.config ?? Promise.resolve({ ok: true, data: CFG }),
    event: (e) => void events.push(e),
    onStop: (cb) => void (stopCb = cb),
  };
  const capture = { stop: vi.fn(async () => {}) };
  const mic: OpenedMic = { start: vi.fn(() => capture), release: vi.fn() };
  const openMic = vi.fn(() => opts.mic ?? Promise.resolve(mic));
  return { api, events, capture, mic, openMic, stop: () => stopCb?.() };
}

describe("runMicWindow", () => {
  it("starts capture with the config, and on stop finishes it, then lets go of the mic", async () => {
    const h = harness();
    await runMicWindow(h.api, h.openMic);
    expect(h.mic.start).toHaveBeenCalledWith(CFG);
    h.stop();
    h.stop();
    await vi.waitFor(() => expect(h.mic.release).toHaveBeenCalledTimes(1));
    expect(h.capture.stop).toHaveBeenCalledTimes(1);
  });

  it("opens no mic when stopped while the config is still on its way", async () => {
    const config = deferred<ConfigReply>();
    const h = harness({ config: config.promise });
    const running = runMicWindow(h.api, h.openMic);
    h.stop();
    config.resolve({ ok: true, data: CFG });
    await running;
    expect(h.openMic).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ type: "stopped" }]);
  });

  it("lets go of a mic that opened after a stop, and starts nothing on it", async () => {
    const opened = deferred<OpenedMic>();
    const h = harness({ mic: opened.promise });
    const running = runMicWindow(h.api, h.openMic);
    await vi.waitFor(() => expect(h.openMic).toHaveBeenCalled());
    h.stop();
    opened.resolve(h.mic);
    await running;
    expect(h.mic.start).not.toHaveBeenCalled();
    expect(h.mic.release).toHaveBeenCalled();
    expect(h.events).toEqual([{ type: "stopped" }]);
  });

  it("reports a refused config, then stopped", async () => {
    const h = harness({ config: Promise.resolve({ ok: false, error: "Refused" }) });
    await runMicWindow(h.api, h.openMic);
    expect(h.events).toEqual([{ type: "error", kind: "unavailable", message: "Refused" }, { type: "stopped" }]);
  });

  it("reports a denied mic in the user's words, then stopped", async () => {
    const h = harness({ mic: Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })) });
    await runMicWindow(h.api, h.openMic);
    expect(h.events).toEqual([
      { type: "error", kind: "denied", message: expect.stringMatching(/System Settings/) },
      { type: "stopped" },
    ]);
  });

  it("reports a capture that could not be set up, lets go of the mic, then stopped", async () => {
    const h = harness();
    vi.mocked(h.mic.start).mockImplementation(() => {
      throw Object.assign(new Error("no audio context"), { name: "NotSupportedError" });
    });
    await runMicWindow(h.api, h.openMic);
    expect(h.mic.release).toHaveBeenCalled();
    expect(h.events).toEqual([
      { type: "error", kind: "unavailable", message: "The microphone is in use or not responding." },
      { type: "stopped" },
    ]);
  });
});

describe("runMicWindow, Codex #89 r2 [P1]", () => {
  it("starts nothing when the main process says the recorder stopped before the page listened", async () => {
    const h = harness({
      config: Promise.resolve({ ok: false, cancelled: true, error: "The recorder stopped before the mic window started." }),
    });
    await runMicWindow(h.api, h.openMic);
    expect(h.openMic).not.toHaveBeenCalled();
    // Cancelled is not a failure: no error event, just stopped.
    expect(h.events).toEqual([{ type: "stopped" }]);
  });
});
