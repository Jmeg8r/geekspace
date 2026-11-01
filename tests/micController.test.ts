import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMicController, type CaptureWindow, type MicState } from "../electron/micController.mjs";
import type { Handled, IncomingMessage } from "../electron/micSegments.mjs";

// WHAT: the main process's handle on the hidden mic capture window (plan PR 3d-2). WHY
// tested: it is the only code that accepts messages from that window, so it must ignore
// every other sender; and a mic failure must degrade loudly (James, 2026-10-31): capture of
// screens and system audio carries on, and the mic's state says what went wrong.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeWindow() {
  const sent: string[] = [];
  let destroyed = false;
  const win: CaptureWindow = {
    webContents: { id: 7, send: (channel: string) => void sent.push(channel) },
    destroy: () => void (destroyed = true),
    isDestroyed: () => destroyed,
  };
  return { win, sent, destroyed: () => destroyed };
}

function harness(opts: { mic?: boolean; handle?: (m: IncomingMessage) => Handled } = {}) {
  const windows: ReturnType<typeof fakeWindow>[] = [];
  let gone: (() => void) | null = null;
  const states: MicState[] = [];
  const logs: string[] = [];
  const handled: IncomingMessage[] = [];
  const errors: string[] = [];
  const writer = {
    handle: (m: IncomingMessage): Handled => {
      handled.push(m);
      return opts.handle ? opts.handle(m) : { ok: true };
    },
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const controller = createMicController({
    askMic: async () => opts.mic ?? true,
    createWindow: ({ onGone }) => {
      const w = fakeWindow();
      windows.push(w);
      gone = onGone;
      return w.win;
    },
    createWriter: () => writer,
    onState: (s) => void states.push(s),
    recordError: (detail) => void errors.push(detail),
    log: (m) => void logs.push(m),
    stopTimeoutMs: 1000,
  });
  const fromWindow = (i = 0) => windows[i].win.webContents;
  return { controller, windows, states, logs, handled, errors, writer, fromWindow, gone: () => gone?.() };
}

describe("createMicController", () => {
  it("opens one hidden window and reports ok once a segment starts", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.start();
    expect(h.windows).toHaveLength(1);
    expect(h.states.at(-1)).toEqual({ state: "starting" });
    h.controller.receive(h.fromWindow(), { type: "segmentStart", segment: 0, start: 1 });
    expect(h.states.at(-1)).toEqual({ state: "ok" });
  });

  it("ignores messages from any sender but its own window", async () => {
    const h = harness();
    await h.controller.start();
    h.controller.receive({ id: 99 }, { type: "segmentStart", segment: 0, start: 1 });
    expect(h.handled).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/another sender/);
  });

  it("degrades loudly when the mic is denied: no window, an error state, a capError", async () => {
    const h = harness({ mic: false });
    await h.controller.start();
    expect(h.windows).toEqual([]);
    expect(h.states.at(-1)).toEqual({ state: "error", kind: "denied", error: expect.stringMatching(/Microphone/) });
    expect(h.errors).toHaveLength(1);
  });

  it.each([[{ type: "silent", silentSec: "25" }], [{ type: "silent", silentSec: -1 }], [{ type: "silent" }]])(
    "treats a malformed silence report %j as a protocol error",
    async (message) => {
      const h = harness();
      await h.controller.start();
      h.controller.receive(h.fromWindow(), message);
      expect(h.states.at(-1)).toMatchObject({ state: "error", kind: "protocol" });
    }
  );

  it("follows silence and signal from the window", async () => {
    const h = harness();
    await h.controller.start();
    h.controller.receive(h.fromWindow(), { type: "silent", silentSec: 25 });
    expect(h.states.at(-1)).toEqual({ state: "silent", silentSec: 25 });
    h.controller.receive(h.fromWindow(), { type: "signal" });
    expect(h.states.at(-1)).toEqual({ state: "ok" });
  });

  it("turns a window error into an error state and closes the window", async () => {
    const h = harness();
    await h.controller.start();
    h.controller.receive(h.fromWindow(), { type: "error", kind: "deviceLost", message: "The microphone was disconnected." });
    h.controller.receive(h.fromWindow(), { type: "stopped" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.at(-1)).toEqual({ state: "error", kind: "deviceLost", error: "The microphone was disconnected." });
    expect(h.windows[0].destroyed()).toBe(true);
    expect(h.errors).toEqual(["mic: The microphone was disconnected."]);
  });

  it("treats a message the writer refuses as an error, and stops the window", async () => {
    const h = harness({ handle: () => ({ ok: false, reason: "chunk is over the cap" }) });
    await h.controller.start();
    h.controller.receive(h.fromWindow(), { type: "chunk", segment: 0, bytes: new ArrayBuffer(1) });
    expect(h.states.at(-1)).toMatchObject({ state: "error", kind: "protocol" });
    expect(h.windows[0].sent).toContain("gs:mic:stop");
  });

  it("treats an empty segment while recording as a dead mic", async () => {
    const h = harness({ handle: () => ({ ok: true, empty: true }) });
    await h.controller.start();
    h.controller.receive(h.fromWindow(), { type: "segmentEnd", segment: 0, end: 2 });
    expect(h.states.at(-1)).toMatchObject({ state: "error", kind: "noAudio" });
    expect(h.errors).toHaveLength(1);
  });

  it("drops an empty final segment at a stop without calling it an error", async () => {
    const h = harness({ handle: () => ({ ok: true, empty: true }) });
    await h.controller.start();
    const stopping = h.controller.stop();
    h.controller.receive(h.fromWindow(), { type: "segmentEnd", segment: 3, end: 2 });
    h.controller.receive(h.fromWindow(), { type: "stopped" });
    await stopping;
    expect(h.errors).toEqual([]);
    expect(h.states.at(-1)).toEqual({ state: "off" });
  });

  it("stop asks the window to finish, waits for stopped, then drains and closes", async () => {
    const h = harness();
    await h.controller.start();
    const stopping = h.controller.stop();
    expect(h.windows[0].sent).toEqual(["gs:mic:stop"]);
    expect(h.windows[0].destroyed()).toBe(false);
    h.controller.receive(h.fromWindow(), { type: "stopped" });
    await stopping;
    expect(h.windows[0].destroyed()).toBe(true);
    expect(h.writer.drain).toHaveBeenCalled();
    expect(h.writer.close).toHaveBeenCalled();
    expect(h.states.at(-1)).toEqual({ state: "off" });
  });

  it("closes the window anyway when stopped never comes, and says so", async () => {
    const h = harness();
    await h.controller.start();
    const stopping = h.controller.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(h.windows[0].destroyed()).toBe(true);
    expect(h.logs.join("\n")).toMatch(/did not stop/);
  });

  it("reports a crashed capture window as an error", async () => {
    const h = harness();
    await h.controller.start();
    h.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.at(-1)).toMatchObject({ state: "error", kind: "windowGone" });
  });

  it("owns only its own window's sender, for the config handler's check", async () => {
    const h = harness();
    expect(h.controller.ownsSender({ id: 7 })).toBe(false);
    await h.controller.start();
    expect(h.controller.ownsSender(h.fromWindow())).toBe(true);
    expect(h.controller.ownsSender({ id: 99 })).toBe(false);
    expect(h.controller.ownsSender(null)).toBe(false);
  });

  it("knows its own window, so main.mjs can leave it out of app-window lookups", async () => {
    const h = harness();
    await h.controller.start();
    expect(h.controller.isCaptureWindow(h.windows[0].win)).toBe(true);
    expect(h.controller.isCaptureWindow(fakeWindow().win)).toBe(false);
  });
});
