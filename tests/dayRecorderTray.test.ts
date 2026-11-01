import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecorderStatus } from "../electron/dayRecorderService.mjs";
import {
  type MenuItem,
  OFF_HOLD_MS,
  PAUSE_ACCELERATOR,
  SHORTCUT_TAKEN,
  type Tone,
  createStatusView,
  dotPng,
  startRecorderIndicator,
  trayImage,
  trayView,
} from "../electron/dayRecorderTray.mjs";

// WHAT: the Day Recorder's menu-bar indicator and ⌥⌘R (plan PR 3e-1). WHY tested: R1 needs
// "Recording" in the menu bar whenever capture is live, and the status the service emits
// passes through `off` on a pause and on a retry (plan.md, 3c part 2 and 3d-1), so a
// literal display would flash "Off" at the user while nothing was turned off.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeSource(initial: RecorderStatus = { status: "off" }) {
  let status = initial;
  const listeners = new Set<(s: RecorderStatus) => void>();
  return {
    status: () => status,
    onStatus: (cb: (s: RecorderStatus) => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    emit(next: RecorderStatus) {
      status = next;
      for (const cb of listeners) cb(next);
    },
    listenerCount: () => listeners.size,
  };
}

function watch(source: ReturnType<typeof fakeSource>) {
  const view = createStatusView(source);
  const seen: string[] = [];
  view.onStatus((s) => void seen.push(s.status));
  return { view, seen };
}

describe("createStatusView", () => {
  it("passes a status straight through", () => {
    const source = fakeSource();
    const { view, seen } = watch(source);
    source.emit({ status: "starting" });
    source.emit({ status: "recording" });
    expect(seen).toEqual(["starting", "recording"]);
    expect(view.status()).toEqual({ status: "recording" });
  });

  it("never shows the off between stopping and paused", () => {
    const source = fakeSource({ status: "recording" });
    const { seen } = watch(source);
    source.emit({ status: "stopping" });
    source.emit({ status: "off" });
    source.emit({ status: "paused" });
    vi.advanceTimersByTime(OFF_HOLD_MS * 4);
    expect(seen).toEqual(["stopping", "paused"]);
  });

  it("never shows the off between notRecording and the retry's starting", () => {
    const source = fakeSource({ status: "recording" });
    const { seen } = watch(source);
    source.emit({ status: "notRecording", error: "helper crashed", retryInMs: 5000 });
    source.emit({ status: "off" });
    source.emit({ status: "starting" });
    vi.advanceTimersByTime(OFF_HOLD_MS * 4);
    expect(seen).toEqual(["notRecording", "starting"]);
  });

  it("shows a real off after stopping, once the hold has passed", () => {
    const source = fakeSource({ status: "recording" });
    const { view, seen } = watch(source);
    source.emit({ status: "stopping" });
    source.emit({ status: "off" });
    source.emit({ status: "off" });
    expect(view.status()).toEqual({ status: "stopping" });
    vi.advanceTimersByTime(OFF_HOLD_MS - 1);
    expect(seen).toEqual(["stopping"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["stopping", "off"]);
    expect(view.status()).toEqual({ status: "off" });
  });

  it("shows an off that follows anything else at once", () => {
    const source = fakeSource({ status: "paused" });
    const { seen } = watch(source);
    source.emit({ status: "off" });
    expect(seen).toEqual(["off"]);
  });

  it("does not repeat a status that has not changed", () => {
    const source = fakeSource();
    const { seen } = watch(source);
    source.emit({ status: "recording" });
    source.emit({ status: "recording" });
    source.emit({ status: "recording", mic: { state: "ok" } });
    expect(seen).toEqual(["recording", "recording"]);
  });

  it("stop() unsubscribes and drops a held off", () => {
    const source = fakeSource({ status: "recording" });
    const { view, seen } = watch(source);
    source.emit({ status: "stopping" });
    source.emit({ status: "off" });
    view.stop();
    vi.advanceTimersByTime(OFF_HOLD_MS * 4);
    expect(seen).toEqual(["stopping"]);
    expect(source.listenerCount()).toBe(0);
  });
});

describe("trayView", () => {
  const on = { shortcut: true };

  it("has no tray while the recorder is off or unsupported", () => {
    expect(trayView({ status: "off" }, on)).toBeNull();
    expect(trayView({ status: "unsupported" }, on)).toBeNull();
  });

  it("says Recording with a red dot while capture is live (spec UI table)", () => {
    expect(trayView({ status: "recording", mic: { state: "ok" } }, on)).toEqual({
      tone: "red",
      title: "Recording",
      tooltip: "Day Recorder is on. ⌥⌘R to pause.",
      action: "pause",
    });
  });

  it("says how to pause when another app holds ⌥⌘R", () => {
    expect(SHORTCUT_TAKEN).toBe(" Another app is using ⌥⌘R, so pause and resume from this menu.");
    expect(trayView({ status: "recording" }, { shortcut: false })?.tooltip).toBe(
      `Day Recorder is on.${SHORTCUT_TAKEN}`
    );
  });

  // Codex #3e-1 r1 P2: the notice belongs to every state, not to Recording alone.
  it("keeps the ⌥⌘R notice in every state's tooltip, after the state's own copy", () => {
    const states: RecorderStatus[] = [
      { status: "paused" },
      { status: "starting" },
      { status: "stopping" },
      { status: "recording", mic: { state: "silent", silentSec: 25 } },
      { status: "recording", mic: { state: "error", kind: "denied", error: "Turn the mic on." } },
      { status: "notRecording", error: "Screen capture stopped.", retryInMs: 5000 },
      { status: "blocked", error: "Turn on FileVault." },
    ];
    for (const status of states) {
      const own = trayView(status, on)?.tooltip;
      expect(trayView(status, { shortcut: false })?.tooltip).toBe(`${own}${SHORTCUT_TAKEN}`);
    }
  });

  it("says Paused with a hollow dot, and offers resume", () => {
    expect(trayView({ status: "paused" }, on)).toEqual({
      tone: "hollow",
      title: "Paused",
      tooltip: "Recording paused. Resume when you're ready.",
      action: "resume",
    });
  });

  it("says Mic silent in amber", () => {
    expect(trayView({ status: "recording", mic: { state: "silent", silentSec: 25 } }, on)).toEqual({
      tone: "amber",
      title: "Mic silent",
      tooltip: "No sound from the microphone for 25 seconds. Check the input in System Settings → Sound, or pause recording.",
      action: "pause",
    });
  });

  it("says the mic stopped while screens and system audio carry on", () => {
    const v = trayView({ status: "recording", mic: { state: "error", kind: "denied", error: "Turn the mic on." } }, on);
    expect(v).toMatchObject({ tone: "amber", title: "Recording without the mic", action: "pause" });
    expect(v?.tooltip).toBe("Recording without the mic. Turn the mic on. Screens and system audio are still recording.");
  });

  it("says Not recording in grey with the error, and when the retry comes", () => {
    expect(trayView({ status: "notRecording", error: "Screen capture stopped.", retryInMs: 30000 }, on)).toEqual({
      tone: "grey",
      title: "Not recording",
      tooltip: "Screen capture stopped. Trying again in 30 s.",
      action: "pause",
    });
    expect(trayView({ status: "blocked", error: "Turn on FileVault." }, on)).toMatchObject({
      tone: "grey",
      title: "Not recording",
      tooltip: "Turn on FileVault.",
    });
  });

  it("never says Recording while starting or stopping", () => {
    expect(trayView({ status: "starting" }, on)).toMatchObject({ tone: "hollow", title: "Starting" });
    expect(trayView({ status: "stopping" }, on)).toMatchObject({ tone: "hollow", title: "Stopping" });
  });
});

/** The pixel at (x, y) of an unfiltered RGBA PNG, as [r, g, b, a]. */
function pixel(png: Buffer, x: number, y: number) {
  let offset = 8;
  let width = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") width = data.readUInt32BE(0);
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const at = y * (width * 4 + 1) + 1 + x * 4;
  return [...raw.subarray(at, at + 4)];
}

describe("dotPng", () => {
  it("is a PNG of the asked size", () => {
    const png = dotPng("red", 32);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
  });

  it("fills the red and amber dots and leaves the corners clear", () => {
    expect(pixel(dotPng("red", 32), 16, 16)).toEqual([0xd9, 0x30, 0x36, 255]);
    expect(pixel(dotPng("amber", 32), 16, 16)).toEqual([0xc2, 0x7c, 0x0e, 255]);
    expect(pixel(dotPng("red", 32), 0, 0)[3]).toBe(0);
  });

  it("draws the hollow dot as a ring, in black for a template image", () => {
    const png = dotPng("hollow", 32);
    expect(pixel(png, 16, 16)[3]).toBe(0);
    expect(pixel(png, 16, 8)).toEqual([0, 0, 0, 255]);
    expect(pixel(dotPng("grey", 32), 16, 16)).toEqual([0, 0, 0, 255]);
  });
});

describe("trayImage", () => {
  function fakeNativeImage() {
    const made: { scaleFactor: number; template: boolean }[] = [];
    return {
      made,
      createFromBuffer: (_png: Buffer, options: { scaleFactor: number }) => {
        const image = { scaleFactor: options.scaleFactor, template: false };
        made.push(image);
        return { setTemplateImage: (on: boolean) => void (image.template = on) };
      },
    };
  }

  it("makes the grey and hollow dots template images, so macOS tints them for the menu bar", () => {
    const tones: Tone[] = ["red", "amber", "grey", "hollow"];
    const n = fakeNativeImage();
    for (const tone of tones) trayImage(n, tone);
    expect(n.made.map((m) => m.template)).toEqual([false, false, true, true]);
    expect(n.made.every((m) => m.scaleFactor === 2)).toBe(true);
  });
});

type FakeTray = { image: string; title: string; tooltip: string; menu: MenuItem[]; destroyed: boolean };

function indicator(opts: { platform?: string; register?: boolean; initial?: RecorderStatus } = {}) {
  const source = fakeSource(opts.initial);
  const trays: FakeTray[] = [];
  let pressed: (() => void) | null = null;
  const shortcut = {
    register: vi.fn((_accelerator: string, cb: () => void) => {
      pressed = cb;
      return opts.register ?? true;
    }),
    unregister: vi.fn(),
  };
  const controls = {
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    setEnabled: vi.fn(async (_enabled: boolean) => {}),
  };
  const showApp = vi.fn();
  const log = vi.fn();
  const handle = startRecorderIndicator<string, MenuItem[]>({
    view: source,
    platform: opts.platform ?? "darwin",
    createTray: (image) => {
      const t: FakeTray = { image, title: "", tooltip: "", menu: [], destroyed: false };
      trays.push(t);
      return {
        setImage: (i) => void (t.image = i),
        setTitle: (s) => void (t.title = s),
        setToolTip: (s) => void (t.tooltip = s),
        setContextMenu: (m) => void (t.menu = m),
        destroy: () => void (t.destroyed = true),
      };
    },
    buildMenu: (items) => items,
    createImage: (tone) => `dot:${tone}`,
    globalShortcut: shortcut,
    controls,
    showApp,
    log,
  });
  const click = (label: string) => {
    const item = trays.at(-1)?.menu.find((m) => "label" in m && m.label === label);
    if (!item || !("click" in item) || !item.click) throw new Error(`no menu item "${label}"`);
    item.click();
  };
  return { source, trays, shortcut, controls, showApp, log, handle, click, press: () => pressed?.() };
}

describe("startRecorderIndicator", () => {
  it("has no tray and no shortcut while the recorder is off", () => {
    const h = indicator();
    expect(h.trays).toHaveLength(0);
    expect(h.shortcut.register).not.toHaveBeenCalled();
  });

  it("shows Recording in the menu bar with its menu, and registers ⌥⌘R", () => {
    const h = indicator();
    h.source.emit({ status: "recording" });
    expect(h.trays).toHaveLength(1);
    expect(h.trays[0]).toMatchObject({ image: "dot:red", title: "Recording", tooltip: "Day Recorder is on. ⌥⌘R to pause." });
    expect(h.trays[0].menu).toEqual([
      { label: "Recording", enabled: false },
      { type: "separator" },
      { label: "Pause recording", accelerator: PAUSE_ACCELERATOR, registerAccelerator: false, click: expect.any(Function) },
      { label: "Open Geekspace", click: expect.any(Function) },
      { type: "separator" },
      { label: "Turn off Day Recorder", click: expect.any(Function) },
    ]);
    expect(h.shortcut.register).toHaveBeenCalledTimes(1);
    expect(h.shortcut.register).toHaveBeenCalledWith(PAUSE_ACCELERATOR, expect.any(Function));
  });

  it("starts showing at once when the recorder is already on", () => {
    const h = indicator({ initial: { status: "paused" } });
    expect(h.trays).toHaveLength(1);
    expect(h.trays[0]).toMatchObject({ image: "dot:hollow", title: "Paused" });
  });

  it("updates the one tray in place, and removes it when the recorder turns off", () => {
    const h = indicator();
    h.source.emit({ status: "starting" });
    h.source.emit({ status: "recording" });
    h.source.emit({ status: "paused" });
    expect(h.trays).toHaveLength(1);
    expect(h.trays[0]).toMatchObject({ image: "dot:hollow", title: "Paused" });
    expect(h.trays[0].menu[2]).toMatchObject({ label: "Resume recording" });
    h.source.emit({ status: "off" });
    expect(h.trays[0].destroyed).toBe(true);
    expect(h.shortcut.unregister).toHaveBeenCalledWith(PAUSE_ACCELERATOR);
    h.source.emit({ status: "recording" });
    expect(h.trays).toHaveLength(2);
    expect(h.shortcut.register).toHaveBeenCalledTimes(2);
  });

  it("⌥⌘R pauses while recording and resumes while paused", () => {
    const h = indicator();
    h.source.emit({ status: "recording" });
    h.press();
    expect(h.controls.pause).toHaveBeenCalledTimes(1);
    h.source.emit({ status: "paused" });
    h.press();
    expect(h.controls.resume).toHaveBeenCalledTimes(1);
  });

  it("the menu pauses, opens the app and turns the recorder off", () => {
    const h = indicator();
    h.source.emit({ status: "recording" });
    h.click("Pause recording");
    h.click("Open Geekspace");
    h.click("Turn off Day Recorder");
    expect(h.controls.pause).toHaveBeenCalledTimes(1);
    expect(h.showApp).toHaveBeenCalledTimes(1);
    expect(h.controls.setEnabled).toHaveBeenCalledWith(false);
  });

  it("says so, loudly, when another app holds ⌥⌘R", () => {
    const h = indicator({ register: false });
    h.source.emit({ status: "recording" });
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("⌥⌘R"));
    expect(h.trays[0].tooltip).toBe(`Day Recorder is on.${SHORTCUT_TAKEN}`);
    h.source.emit({ status: "recording", mic: { state: "silent", silentSec: 25 } });
    expect(h.trays[0].tooltip).toContain(SHORTCUT_TAKEN);
    expect(h.trays[0].menu[2]).not.toHaveProperty("accelerator");
    h.source.emit({ status: "off" });
    expect(h.shortcut.unregister).not.toHaveBeenCalled();
  });

  it("logs a control that fails, instead of dropping it", async () => {
    const h = indicator();
    h.controls.pause.mockRejectedValueOnce(new Error("backend down"));
    h.source.emit({ status: "recording" });
    h.press();
    await vi.runAllTimersAsync();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("backend down"));
  });

  it("does nothing off macOS", () => {
    const h = indicator({ platform: "win32", initial: { status: "recording" } });
    h.source.emit({ status: "paused" });
    expect(h.trays).toHaveLength(0);
    expect(h.shortcut.register).not.toHaveBeenCalled();
  });

  it("stop() removes the tray, the shortcut and the subscription", () => {
    const h = indicator();
    h.source.emit({ status: "recording" });
    h.handle.stop();
    expect(h.trays[0].destroyed).toBe(true);
    expect(h.shortcut.unregister).toHaveBeenCalledWith(PAUSE_ACCELERATOR);
    expect(h.source.listenerCount()).toBe(0);
  });
});
