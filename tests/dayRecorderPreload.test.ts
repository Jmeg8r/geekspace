import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

// WHAT: the Day Recorder's slice of electron/preload.cjs (plan PR 3d-1). WHY tested: the
// review standards ask for narrow, named preload APIs, never a passthrough of ipcRenderer.
// The preload is CommonJS that requires "electron", so it runs here in its own vm context
// with a fake require and a fake contextBridge, and the test inspects exactly what it exposes.

const PRELOAD = path.join(__dirname, "..", "electron", "preload.cjs");

function loadPreload(platform: NodeJS.Platform = "darwin") {
  const exposed: Record<string, Record<string, unknown>> = {};
  const listeners = new Map<string, (event: unknown, data: unknown) => void>();
  const ipcRenderer = {
    invoke: vi.fn(async () => ({ ok: true })),
    on: vi.fn((channel: string, fn: (event: unknown, data: unknown) => void) => void listeners.set(channel, fn)),
    removeListener: vi.fn((channel: string) => void listeners.delete(channel)),
  };
  const contextBridge = {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => void (exposed[key] = api),
  };
  const fakeRequire = (id: string) => {
    if (id !== "electron") throw new Error(`preload required ${id}`);
    return { contextBridge, ipcRenderer };
  };
  vm.runInNewContext(fs.readFileSync(PRELOAD, "utf8"), { require: fakeRequire, process: { platform } });
  // SAFETY: the preload's dayRecorder namespace is a plain object of functions; the first test
  // asserts that every value is a function.
  const dayRecorder = exposed.geekspace.dayRecorder as Record<string, (...args: unknown[]) => unknown>;
  return { dayRecorder, ipcRenderer, listeners };
}

describe("preload dayRecorder namespace", () => {
  it("exposes only status, setEnabled, pause, resume and onEvent", () => {
    const { dayRecorder } = loadPreload();
    expect(Object.keys(dayRecorder).sort()).toEqual(["onEvent", "pause", "resume", "setEnabled", "status"]);
    for (const fn of Object.values(dayRecorder)) expect(typeof fn).toBe("function");
  });

  it("maps each call to its own gs:dayRecorder:* channel", async () => {
    const { dayRecorder, ipcRenderer } = loadPreload();
    await dayRecorder.status();
    await dayRecorder.setEnabled(true);
    await dayRecorder.pause();
    await dayRecorder.resume();
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["gs:dayRecorder:status", undefined],
      ["gs:dayRecorder:setEnabled", { enabled: true }],
      ["gs:dayRecorder:pause", undefined],
      ["gs:dayRecorder:resume", undefined],
    ]);
  });

  it("passes setEnabled's argument through unchanged, so main.mjs's check sees what the page sent", async () => {
    const { dayRecorder, ipcRenderer } = loadPreload();
    await dayRecorder.setEnabled("yes");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("gs:dayRecorder:setEnabled", { enabled: "yes" });
  });

  it("delivers events without the IPC event object, and unsubscribes", () => {
    const { dayRecorder, ipcRenderer, listeners } = loadPreload();
    const cb = vi.fn();
    const off = dayRecorder.onEvent(cb) as () => void;
    listeners.get("gs:dayRecorder:event")!({ sender: "ipc internals" }, { type: "status", status: { status: "paused" } });
    expect(cb).toHaveBeenCalledWith({ type: "status", status: { status: "paused" } });
    expect(cb.mock.calls[0]).toHaveLength(1);
    off();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("gs:dayRecorder:event", expect.any(Function));
  });

  it("is present off macOS too, where the recorder reports unsupported", () => {
    expect(Object.keys(loadPreload("win32").dayRecorder)).toHaveLength(5);
  });
});
