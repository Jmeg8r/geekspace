import { describe, expect, it } from "vitest";
import {
  createDayRecorderService,
  type ServiceOptions,
  type RecorderSettings,
} from "../electron/dayRecorderService.mjs";
import type { StartOptions, SupervisorOptions, SupervisorState } from "../electron/dayRecorder.mjs";

// WHAT: the main-process service that turns Day Recorder settings into a running helper
// (plan PR 3c). It runs the FileVault and Time Machine gates before every start, restarts
// the helper when the denylist changes (protocol.md: the helper reads its arguments once),
// and records capture errors. The supervisor is faked here; its process plumbing has its own
// suite (dayRecorderSupervisor.test.ts).

type Call = { op: "start"; opts: StartOptions } | { op: "stop" };

function fakeSupervisors() {
  const calls: Call[] = [];
  let alive = 0;
  let maxAlive = 0;
  let setCurrent: ((s: SupervisorState) => void) | null = null;
  const make = (opts: SupervisorOptions) => {
    let state: SupervisorState = { status: "off" };
    const set = (s: SupervisorState) => {
      state = s;
      opts.onState(s);
    };
    setCurrent = set;
    return {
      start(o: StartOptions) {
        calls.push({ op: "start", opts: o });
        alive++;
        maxAlive = Math.max(maxAlive, alive);
        set({ status: "recording" });
      },
      async stop() {
        calls.push({ op: "stop" });
        await new Promise((r) => setTimeout(r, 5));
        if (state.status === "recording") alive--;
        set({ status: "off" });
      },
      state: () => state,
      running: () => state.status === "recording",
      killSync: () => {},
    };
  };
  return {
    calls,
    make,
    maxAlive: () => maxAlive,
    // Like the real one: the failed helper has exited, and its own state says so too.
    fail: (message: string) => {
      alive--;
      setCurrent?.({ status: "notRecording", error: { reason: "exited", message, code: 1 } });
    },
  };
}

function harness(overrides: Partial<ServiceOptions> = {}) {
  const sup = fakeSupervisors();
  const events: { kind: string; detail?: string }[] = [];
  const purges: number[] = [];
  const service = createDayRecorderService({
    platform: "darwin",
    mediaRoot: "/tmp/gs-service-root",
    helperPath: "/Applications/Geekspace.app/Contents/Resources/gs-capture",
    log: () => {},
    gates: {
      fileVault: async () => ({ ok: true }),
      backupExclusion: async () => ({ ok: true }),
    },
    createSupervisor: sup.make,
    convex: {
      addScreenshot: async () => {},
      addSegment: async () => {},
      logEvent: async (e) => void events.push(e),
    },
    purge: async () => void purges.push(1),
    ...overrides,
  });
  return { service, sup, events, purges };
}

const on = (denylist: string[] = [], shotSec = 30): RecorderSettings => ({ enabled: true, denylist, shotSec });
const OFF: RecorderSettings = { enabled: false, denylist: [], shotSec: 30 };

describe("Day Recorder service", () => {
  it("starts the helper with the settings once both gates pass", async () => {
    const h = harness();
    await h.service.apply(on(["com.example.denied"], 60));
    expect(h.sup.calls).toEqual([
      { op: "start", opts: { denylist: ["com.example.denied"], shotSec: 60, segmentSec: 300 } },
    ]);
    expect(h.service.status()).toEqual({ status: "recording" });
  });

  it("refuses to start without FileVault, says why, and logs a capError", async () => {
    const h = harness({
      gates: {
        fileVault: async () => ({ ok: false, error: "FileVault is off. Turn it on in System Settings." }),
        backupExclusion: async () => ({ ok: true }),
      },
    });
    await h.service.apply(on());
    expect(h.sup.calls).toEqual([]);
    expect(h.service.status()).toEqual({
      status: "blocked",
      error: "FileVault is off. Turn it on in System Settings.",
    });
    expect(h.events).toEqual([{ kind: "capError", detail: "gate: FileVault is off. Turn it on in System Settings." }]);
  });

  it("refuses to start when the media root can't be kept out of Time Machine", async () => {
    const h = harness({
      gates: {
        fileVault: async () => ({ ok: true }),
        backupExclusion: async () => ({ ok: false, error: "Time Machine still backs up the folder." }),
      },
    });
    await h.service.apply(on());
    expect(h.sup.calls).toEqual([]);
    expect(h.service.status().status).toBe("blocked");
  });

  it("does not restart when the settings that reach the helper are unchanged", async () => {
    const h = harness();
    await h.service.apply(on(["com.example.a"]));
    await h.service.apply(on(["com.example.a"]));
    expect(h.sup.calls.filter((c) => c.op === "start")).toHaveLength(1);
  });

  it("restarts the helper when the denylist changes, stopping the old one first", async () => {
    const h = harness();
    await h.service.apply(on(["com.example.a"]));
    await h.service.apply(on(["com.example.a", "com.example.b"]));
    expect(h.sup.calls.map((c) => c.op)).toEqual(["start", "stop", "start"]);
    expect(h.sup.maxAlive()).toBe(1);
  });

  it("stops the helper when the recorder is turned off", async () => {
    const h = harness();
    await h.service.apply(on());
    await h.service.apply(OFF);
    expect(h.sup.calls.map((c) => c.op)).toEqual(["start", "stop"]);
    expect(h.service.status()).toEqual({ status: "off" });
  });

  it("applies overlapping changes one at a time and ends on the last", async () => {
    const h = harness();
    await Promise.all([
      h.service.apply(on(["com.example.a"])),
      h.service.apply(on(["com.example.b"])),
      h.service.apply(on(["com.example.c"])),
    ]);
    expect(h.sup.maxAlive()).toBe(1);
    const starts = h.sup.calls.filter((c) => c.op === "start");
    expect(starts.at(-1)).toEqual({ op: "start", opts: { denylist: ["com.example.c"], shotSec: 30, segmentSec: 300 } });
  });

  it("is unsupported off macOS and never starts a helper", async () => {
    const h = harness({ platform: "win32" });
    await h.service.apply(on());
    expect(h.sup.calls).toEqual([]);
    expect(h.service.status().status).toBe("unsupported");
  });

  it("records a capError, without captured content, when the helper fails", async () => {
    const h = harness();
    await h.service.apply(on());
    h.sup.fail("Screen Recording permission was revoked");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.service.status().status).toBe("notRecording");
    expect(h.events).toEqual([{ kind: "capError", detail: "exited: Screen Recording permission was revoked" }]);
  });

  it("retries a failed helper on the next settings change, even if nothing changed", async () => {
    const h = harness();
    await h.service.apply(on());
    h.sup.fail("helper crashed");
    await h.service.apply(on());
    expect(h.sup.calls.map((c) => c.op)).toEqual(["start", "stop", "start"]);
  });

  it("runs the purge when recording starts", async () => {
    const h = harness();
    await h.service.apply(on());
    expect(h.purges).toHaveLength(1);
    await h.service.shutdown();
  });

  it("shutdown stops a running helper", async () => {
    const h = harness();
    await h.service.apply(on());
    await h.service.shutdown();
    expect(h.sup.calls.map((c) => c.op)).toEqual(["start", "stop"]);
  });
});
