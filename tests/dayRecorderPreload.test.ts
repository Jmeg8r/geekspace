import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

// WHAT: the Day Recorder's slice of electron/preload.cjs (plan PR 3d-1). WHY tested: the
// review standards ask for narrow, named preload APIs, never a passthrough of ipcRenderer.
// The preload is CommonJS that requires "electron", so it runs here in its own vm context
// with a fake require and a fake contextBridge, and the test inspects exactly what it exposes.

const PRELOAD = path.join(__dirname, "..", "electron", "preload.cjs");

type IpcEventStub = { sender: string };
type DayRecorderEvent = { type: "status"; status: { status: string } };
type IpcListener = (event: IpcEventStub, data: DayRecorderEvent) => void;
type IpcReply = { ok: boolean };
type PreloadArg = boolean | string | number | ((event: DayRecorderEvent) => void);
type PreloadFn = (...args: PreloadArg[]) => Promise<IpcReply> | (() => void);
type Namespaces = Record<string, Record<string, PreloadFn>>;

/** onEvent returns its unsubscribe; every other call returns the invoke promise. */
function unsubscribeFrom(result: ReturnType<PreloadFn>): () => void {
  if (result instanceof Promise) throw new Error("onEvent returned a promise, not an unsubscribe");
  return result;
}

function loadPreload(platform: NodeJS.Platform = "darwin") {
  const exposed: Record<string, Namespaces> = {};
  const listeners = new Map<string, IpcListener>();
  const ipcRenderer = {
    invoke: vi.fn(async () => ({ ok: true })),
    on: vi.fn((channel: string, fn: IpcListener) => void listeners.set(channel, fn)),
    removeListener: vi.fn((channel: string) => void listeners.delete(channel)),
  };
  const contextBridge = {
    exposeInMainWorld: (key: string, api: Namespaces) => void (exposed[key] = api),
  };
  const fakeRequire = (id: string) => {
    if (id !== "electron") throw new Error(`preload required ${id}`);
    return { contextBridge, ipcRenderer };
  };
  vm.runInNewContext(fs.readFileSync(PRELOAD, "utf8"), { require: fakeRequire, process: { platform } });
  const dayRecorder = exposed.geekspace.dayRecorder;
  return { dayRecorder, ipcRenderer, listeners };
}

describe("preload dayRecorder namespace", () => {
  it("exposes only the recorder controls, the call notice answers and onEvent", () => {
    const { dayRecorder } = loadPreload();
    expect(Object.keys(dayRecorder).sort()).toEqual([
      "callPrompt",
      "dismissCallWarning",
      "extendNotice",
      "noticeDeclined",
      "noticeGiven",
      "onEvent",
      "pause",
      "resume",
      "setEnabled",
      "status",
    ]);
    // expect.any, not toBeInstanceOf: the preload ran in its own vm context, with its own Function.
    for (const fn of Object.values(dayRecorder)) expect(fn).toEqual(expect.any(Function));
  });

  it("maps each call to its own gs:dayRecorder:* channel", async () => {
    const { dayRecorder, ipcRenderer } = loadPreload();
    await dayRecorder.status();
    await dayRecorder.setEnabled(true);
    await dayRecorder.pause();
    await dayRecorder.resume();
    await dayRecorder.noticeGiven("call-1");
    await dayRecorder.noticeDeclined("call-1");
    await dayRecorder.extendNotice("call-1");
    await dayRecorder.dismissCallWarning();
    await dayRecorder.callPrompt();
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["gs:dayRecorder:status", undefined],
      ["gs:dayRecorder:setEnabled", { enabled: true }],
      ["gs:dayRecorder:pause", undefined],
      ["gs:dayRecorder:resume", undefined],
      ["gs:dayRecorder:noticeGiven", { callId: "call-1" }],
      ["gs:dayRecorder:noticeDeclined", { callId: "call-1" }],
      ["gs:dayRecorder:extendNotice", { callId: "call-1" }],
      ["gs:dayRecorder:dismissCallWarning", undefined],
      ["gs:dayRecorder:callPrompt", undefined],
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
    const off = unsubscribeFrom(dayRecorder.onEvent(cb));
    listeners.get("gs:dayRecorder:event")!({ sender: "ipc internals" }, { type: "status", status: { status: "paused" } });
    expect(cb).toHaveBeenCalledWith({ type: "status", status: { status: "paused" } });
    expect(cb.mock.calls[0]).toHaveLength(1);
    off();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("gs:dayRecorder:event", expect.any(Function));
  });

  it("is present off macOS too, where the recorder reports unsupported", () => {
    expect(Object.keys(loadPreload("win32").dayRecorder)).toHaveLength(10);
  });
});

// Plan PR 6a, spec F4: the assistant's key is write-only from the page.
describe("preload assistant namespace", () => {
  it("can set, clear and ask whether there is a key, never read it", async () => {
    const exposed: Record<string, Namespaces> = {};
    const ipcRenderer = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const contextBridge = { exposeInMainWorld: (key: string, api: Namespaces) => void (exposed[key] = api) };
    const fakeRequire = () => ({ contextBridge, ipcRenderer });
    vm.runInNewContext(fs.readFileSync(PRELOAD, "utf8"), { require: fakeRequire, process: { platform: "darwin" } });
    const assistant = exposed.geekspace.assistant;
    expect(Object.keys(assistant).sort()).toEqual(["clearApiKey", "hasApiKey", "requestImage", "setApiKey", "summarize"]);
    await assistant.summarize("2026-11-02", 1, 2);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("gs:assistant:summarize", { day: "2026-11-02", from: 1, to: 2 });
    await assistant.requestImage("shot-1");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("gs:assistant:requestImage", { screenshotId: "shot-1" });
    await assistant.setApiKey("sk-ant-SYNTHETIC");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("gs:assistant:setApiKey", { key: "sk-ant-SYNTHETIC" });
  });
});

// Plan PR 6b, spec R12: the Linear key is write-only too, and a draft is approved by id only.
describe("preload linear namespace", () => {
  it("can set, clear and ask about the key, and approve a draft by id", async () => {
    const exposed: Record<string, Namespaces> = {};
    const ipcRenderer = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const contextBridge = { exposeInMainWorld: (key: string, api: Namespaces) => void (exposed[key] = api) };
    const fakeRequire = () => ({ contextBridge, ipcRenderer });
    vm.runInNewContext(fs.readFileSync(PRELOAD, "utf8"), { require: fakeRequire, process: { platform: "darwin" } });
    const linear = exposed.geekspace.linear;
    expect(Object.keys(linear).sort()).toEqual(["approve", "clearApiKey", "hasApiKey", "setApiKey"]);
    await linear.approve("draft-1");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("gs:linear:approve", { draftId: "draft-1" });
  });
});
