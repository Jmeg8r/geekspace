import { describe, expect, it, vi } from "vitest";
import {
  type ControlHandler,
  DAY_RECORDER_EVENT,
  createDayRecorderControls,
  forwardStatus,
  registerDayRecorderIpc,
} from "../electron/dayRecorderIpc.mjs";
import type { RecorderStatus } from "../electron/dayRecorderService.mjs";

// WHAT: the renderer's controls for the Day Recorder (plan PR 3d-1): the gs:dayRecorder:*
// handlers, the settings patch behind each control, and the status push. WHY tested: these
// handlers are the boundary between the renderer and the recorder, so each one validates its
// argument and goes through main.mjs's handle(), which refuses any sender but the app page.


function fakeHandle() {
  const handlers = new Map<string, ControlHandler>();
  const handle = (channel: string, fn: ControlHandler) => void handlers.set(channel, fn);
  return { handle, handlers };
}

function fakeRecorder(status: RecorderStatus = { status: "off" }) {
  return {
    service: { status: () => status },
    setEnabled: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
}

describe("registerDayRecorderIpc", () => {
  it("registers exactly the four control channels, all through the guarded handle()", () => {
    const h = fakeHandle();
    registerDayRecorderIpc({ handle: h.handle, recorder: () => fakeRecorder() });
    expect([...h.handlers.keys()].sort()).toEqual([
      "gs:dayRecorder:pause",
      "gs:dayRecorder:resume",
      "gs:dayRecorder:setEnabled",
      "gs:dayRecorder:status",
    ]);
  });

  it("returns the service's status", async () => {
    const h = fakeHandle();
    registerDayRecorderIpc({ handle: h.handle, recorder: () => fakeRecorder({ status: "paused" }) });
    expect(await h.handlers.get("gs:dayRecorder:status")!({})).toEqual({ status: "paused" });
  });

  it("passes setEnabled, pause and resume through", async () => {
    const h = fakeHandle();
    const r = fakeRecorder();
    registerDayRecorderIpc({ handle: h.handle, recorder: () => r });
    await h.handlers.get("gs:dayRecorder:setEnabled")!({ enabled: true });
    await h.handlers.get("gs:dayRecorder:pause")!({});
    await h.handlers.get("gs:dayRecorder:resume")!({});
    expect(r.setEnabled).toHaveBeenCalledWith(true);
    expect(r.pause).toHaveBeenCalledOnce();
    expect(r.resume).toHaveBeenCalledOnce();
  });

  it.each([[{}], [{ enabled: "true" }], [{ enabled: 1 }], [{ enabled: null }]])(
    "refuses setEnabled(%j): only a real boolean turns capture on or off",
    async (args) => {
      const h = fakeHandle();
      const r = fakeRecorder();
      registerDayRecorderIpc({ handle: h.handle, recorder: () => r });
      await expect(async () => h.handlers.get("gs:dayRecorder:setEnabled")!(args)).rejects.toThrow(/true or false/);
      expect(r.setEnabled).not.toHaveBeenCalled();
    }
  );

  it("says so when the recorder never started, instead of pretending it is off", async () => {
    const h = fakeHandle();
    registerDayRecorderIpc({ handle: h.handle, recorder: () => null });
    for (const channel of h.handlers.keys()) {
      await expect(async () => h.handlers.get(channel)!({ enabled: true })).rejects.toThrow(/not running/);
    }
  });
});

describe("createDayRecorderControls", () => {
  it("maps each control to one settings patch", async () => {
    const patches: object[] = [];
    const c = createDayRecorderControls(async (p) => void patches.push(p));
    await c.setEnabled(true);
    await c.setEnabled(false);
    await c.pause();
    await c.resume();
    expect(patches).toEqual([
      // Turning the recorder on is a request to record, so it also clears a saved pause.
      { enabled: true, paused: false },
      { enabled: false },
      { paused: true },
      { paused: false },
    ]);
  });

  it("surfaces a failed save to the caller", async () => {
    const c = createDayRecorderControls(async () => {
      throw new Error("backend down");
    });
    await expect(c.pause()).rejects.toThrow("backend down");
  });
});

describe("forwardStatus", () => {
  function fakeWindow(destroyed = false) {
    return { isDestroyed: () => destroyed, webContents: { send: vi.fn() } };
  }

  it("pushes each status to every open window, and stops when unsubscribed", () => {
    const listeners = new Set<(s: RecorderStatus) => void>();
    const service = {
      onStatus(cb: (s: RecorderStatus) => void) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const open = fakeWindow();
    const closed = fakeWindow(true);
    const stop = forwardStatus({ service, windows: () => [open, closed] });
    for (const cb of listeners) cb({ status: "recording" });
    expect(open.webContents.send).toHaveBeenCalledWith(DAY_RECORDER_EVENT, {
      type: "status",
      status: { status: "recording" },
    });
    expect(closed.webContents.send).not.toHaveBeenCalled();
    stop();
    expect(listeners.size).toBe(0);
  });
});
