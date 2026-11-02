import { describe, expect, it, vi } from "vitest";
import {
  type ControlHandler,
  DAY_RECORDER_EVENT,
  type DayRecorderEvent,
  createDayRecorderControls,
  forwardCallPrompt,
  forwardStatus,
  registerDayRecorderIpc,
} from "../electron/dayRecorderIpc.mjs";
import type { CallPrompt } from "../electron/callNotice.mjs";
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
    view: { status: () => status },
    setEnabled: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    callPrompt: (): CallPrompt => ({ state: "asking", callId: "call-1", app: "us.zoom.xos", deadline: 1, canExtend: true }),
    notice: {
      given: vi.fn(async (_callId: string) => {}),
      declined: vi.fn(async (_callId: string) => {}),
      extend: vi.fn((_callId: string) => {}),
      dismiss: vi.fn(() => {}),
    },
  };
}

describe("registerDayRecorderIpc", () => {
  it("registers exactly the control and call notice channels, all through the guarded handle()", () => {
    const h = fakeHandle();
    registerDayRecorderIpc({ handle: h.handle, recorder: () => fakeRecorder() });
    expect([...h.handlers.keys()].sort()).toEqual([
      "gs:dayRecorder:callPrompt",
      "gs:dayRecorder:dismissCallWarning",
      "gs:dayRecorder:extendNotice",
      "gs:dayRecorder:noticeDeclined",
      "gs:dayRecorder:noticeGiven",
      "gs:dayRecorder:pause",
      "gs:dayRecorder:resume",
      "gs:dayRecorder:setEnabled",
      "gs:dayRecorder:status",
    ]);
  });

  // Plan PR 4b: the call notice answers. A call id is the only argument, and it is checked.
  it("passes the call notice answers through with their call id", async () => {
    const h = fakeHandle();
    const r = fakeRecorder();
    registerDayRecorderIpc({ handle: h.handle, recorder: () => r });
    await h.handlers.get("gs:dayRecorder:noticeGiven")!({ callId: "call-1" });
    await h.handlers.get("gs:dayRecorder:noticeDeclined")!({ callId: "call-2" });
    await h.handlers.get("gs:dayRecorder:extendNotice")!({ callId: "call-3" });
    await h.handlers.get("gs:dayRecorder:dismissCallWarning")!({});
    expect(r.notice.given).toHaveBeenCalledWith("call-1");
    expect(r.notice.declined).toHaveBeenCalledWith("call-2");
    expect(r.notice.extend).toHaveBeenCalledWith("call-3");
    expect(r.notice.dismiss).toHaveBeenCalledOnce();
    expect(await h.handlers.get("gs:dayRecorder:callPrompt")!({})).toMatchObject({ state: "asking", callId: "call-1" });
  });

  it.each([[{}], [{ callId: 3 }], [{ callId: "" }], [{ callId: "x".repeat(65) }]])(
    "refuses noticeGiven(%j): a call id is a short string",
    async (args) => {
      const h = fakeHandle();
      const r = fakeRecorder();
      registerDayRecorderIpc({ handle: h.handle, recorder: () => r });
      await expect(async () => h.handlers.get("gs:dayRecorder:noticeGiven")!(args)).rejects.toThrow(/call id/);
      expect(r.notice.given).not.toHaveBeenCalled();
    }
  );

  // The view, not the service: a page that asks mid-pause must not read the passing `off`.
  it("returns the status view's status", async () => {
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

describe("forwardCallPrompt", () => {
  it("pushes each prompt to every open window, and stops when unsubscribed", () => {
    let emit: ((p: CallPrompt | null) => void) | null = null;
    const recorder = {
      onCallPrompt: (cb: (p: CallPrompt | null) => void) => {
        emit = cb;
        return () => void (emit = null);
      },
    };
    const sent: string[] = [];
    const open = { isDestroyed: () => false, webContents: { send: (ch: string, p: DayRecorderEvent) => void sent.push(`${ch} ${p.type}`) } };
    const closed = { isDestroyed: () => true, webContents: { send: () => void sent.push("closed") } };
    const stop = forwardCallPrompt({ recorder, windows: () => [open, closed] });
    emit!({ state: "timedOut", callId: "c" });
    expect(sent).toEqual([`${DAY_RECORDER_EVENT} call`]);
    stop();
    expect(emit).toBeNull();
  });
});
