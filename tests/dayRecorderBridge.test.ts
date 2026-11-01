import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecorderStatus } from "../electron/dayRecorderService.mjs";
import {
  dayRecorderAvailable,
  onRecorderStatus,
  pauseRecorder,
  recorderStatus,
  setRecorderEnabled,
} from "../src/lib/dayRecorderBridge";

// WHAT: the renderer's typed wrapper over window.geekspace.dayRecorder (plan PR 3e-2).
// WHY tested: every control goes through it, so an IPC failure must come back as an error
// the UI can show, never a thrown promise or a silent no-op.

type Event = { type: "status"; status: RecorderStatus } | { type: "other" };

function install(bridge: object | undefined) {
  vi.stubGlobal("window", bridge ? { geekspace: { dayRecorder: bridge } } : {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dayRecorderBridge", () => {
  it("says the desktop app is needed outside it", async () => {
    install(undefined);
    expect(dayRecorderAvailable()).toBe(false);
    expect(await recorderStatus()).toEqual({ ok: false, error: "The Day Recorder needs the desktop app." });
  });

  it("passes the main process's answer through", async () => {
    install({ status: async () => ({ ok: true, data: { status: "paused" } }) });
    expect(dayRecorderAvailable()).toBe(true);
    expect(await recorderStatus()).toEqual({ ok: true, data: { status: "paused" } });
  });

  it("turns a thrown IPC call into an error result", async () => {
    install({
      setEnabled: async () => {
        throw new Error("IPC gone");
      },
    });
    expect(await setRecorderEnabled(true)).toEqual({ ok: false, error: "IPC gone" });
  });

  it("passes the main process's refusal through", async () => {
    install({ pause: async () => ({ ok: false, error: "The Day Recorder is not running." }) });
    expect(await pauseRecorder()).toEqual({ ok: false, error: "The Day Recorder is not running." });
  });

  it("delivers status events only, and unsubscribes", () => {
    let listener: ((e: Event) => void) | null = null;
    const off = vi.fn();
    install({
      onEvent: (cb: (e: Event) => void) => {
        listener = cb;
        return off;
      },
    });
    const seen: string[] = [];
    const stop = onRecorderStatus((s) => void seen.push(s.status));
    listener!({ type: "other" });
    listener!({ type: "status", status: { status: "recording" } });
    expect(seen).toEqual(["recording"]);
    stop();
    expect(off).toHaveBeenCalledOnce();
  });
});
