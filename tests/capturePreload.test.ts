import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

// WHAT: electron/capturePreload.cjs, the hidden mic window's own preload (plan PR 3d-2). WHY
// tested: this window streams bytes into the media root, so its bridge must be exactly three
// named calls, and the main window's preload must never carry them.

const DIR = path.join(__dirname, "..", "electron");

type Reply = { ok: boolean };
type Listener = (event: { sender: string }) => void;
type BridgeArg = object | (() => void);
type BridgeFn = (...args: BridgeArg[]) => Promise<Reply> | void | (() => void);

function load(file: string) {
  const exposed: Record<string, Record<string, BridgeFn>> = {};
  const listeners = new Map<string, Listener>();
  const ipcRenderer = {
    invoke: vi.fn(async () => ({ ok: true })),
    send: vi.fn(),
    on: vi.fn((channel: string, fn: Listener) => void listeners.set(channel, fn)),
    removeListener: vi.fn(),
  };
  const contextBridge = {
    exposeInMainWorld: (key: string, api: Record<string, BridgeFn>) => void (exposed[key] = api),
  };
  const fakeRequire = (id: string) => {
    if (id !== "electron") throw new Error(`preload required ${id}`);
    return { contextBridge, ipcRenderer };
  };
  vm.runInNewContext(fs.readFileSync(path.join(DIR, file), "utf8"), {
    require: fakeRequire,
    process: { platform: "darwin" },
  });
  return { exposed, ipcRenderer, listeners };
}

describe("capture window preload", () => {
  it("exposes only gsCapture.config, event and onStop", () => {
    const { exposed } = load("capturePreload.cjs");
    expect(Object.keys(exposed)).toEqual(["gsCapture"]);
    expect(Object.keys(exposed.gsCapture).sort()).toEqual(["config", "event", "onStop"]);
  });

  it("maps each call to its own gs:mic:* channel", async () => {
    const { exposed, ipcRenderer, listeners } = load("capturePreload.cjs");
    const bridge = exposed.gsCapture;
    await bridge.config();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("gs:mic:config");
    bridge.event({ type: "signal" });
    expect(ipcRenderer.send).toHaveBeenCalledWith("gs:mic:event", { type: "signal" });
    const cb = vi.fn();
    bridge.onStop(cb);
    listeners.get("gs:mic:stop")!({ sender: "ipc internals" });
    expect(cb).toHaveBeenCalledWith();
  });

  it("is not reachable from the main window's preload", () => {
    const { exposed } = load("preload.cjs");
    expect(JSON.stringify(Object.keys(exposed.geekspace))).not.toMatch(/capture|mic/i);
    expect(fs.readFileSync(path.join(DIR, "preload.cjs"), "utf8")).not.toMatch(/gs:mic:/);
  });
});
