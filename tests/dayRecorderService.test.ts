import { describe, expect, it } from "vitest";
import {
  createDayRecorderService,
  createQuitHold,
  type ServiceOptions,
  type RecorderSettings,
} from "../electron/dayRecorderService.mjs";
import type { StartOptions, SupervisorOptions, SupervisorState } from "../electron/dayRecorder.mjs";

// WHAT: the main-process service that turns Day Recorder settings into a running helper
// (plan PR 3c). It runs the FileVault and Time Machine gates before every start, restarts
// the helper when the denylist changes (protocol.md: the helper reads its arguments once),
// and records capture errors. The supervisor is faked here; its process plumbing has its own
// suite (dayRecorderSupervisor.test.ts).

type Call = { op: "start"; opts: StartOptions } | { op: "stop" } | { op: "kill" };

/** A promise the test resolves by hand, to hold a gate or a stop open. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeSupervisors() {
  const calls: Call[] = [];
  let alive = 0;
  let maxAlive = 0;
  let setCurrent: ((s: SupervisorState) => void) | null = null;
  let holdStop: Promise<void> | null = null;
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
        const wasAlive = state.status === "recording";
        set({ status: "stopping" });
        await (holdStop ?? new Promise((r) => setTimeout(r, 5)));
        if (wasAlive) alive--;
        set({ status: "off" });
      },
      state: () => state,
      running: () => state.status === "recording",
      killSync: () => void calls.push({ op: "kill" }),
    };
  };
  return {
    calls,
    make,
    maxAlive: () => maxAlive,
    holdStops: (p: Promise<void> | null) => (holdStop = p),
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

  it("runs the purge on the first settings even when recording is off", async () => {
    // Codex #80 r1: retention must not depend on capture being on (spec R14). Media recorded
    // once and then switched off still has to go after 30 days.
    const h = harness();
    await h.service.apply(OFF);
    expect(h.purges).toHaveLength(1);
    await h.service.shutdown();
  });

  it("keeps purging on its interval while off and blocked, and stops at shutdown", async () => {
    const h = harness({
      purgeIntervalMs: 20,
      gates: { fileVault: async () => ({ ok: false, error: "FileVault is off." }), backupExclusion: async () => ({ ok: true }) },
    });
    await h.service.apply(on());
    await new Promise((r) => setTimeout(r, 70));
    expect(h.purges.length).toBeGreaterThanOrEqual(3);
    await h.service.shutdown();
    const after = h.purges.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(h.purges.length).toBe(after);
  });

  it("never purges off macOS, where there is no media root", async () => {
    const h = harness({ platform: "win32" });
    await h.service.apply(OFF);
    expect(h.purges).toEqual([]);
  });

  it("does not report Recording while a restart is stopping and re-running the gates", async () => {
    // Codex #80 r1: the old supervisor's stopping/off reached nobody, so the status stayed
    // Recording with no helper while the gates ran.
    const gate = deferred<{ ok: true }>();
    let calls = 0;
    const h = harness({
      gates: {
        fileVault: () => (++calls === 1 ? Promise.resolve({ ok: true as const }) : gate.promise),
        backupExclusion: async () => ({ ok: true }),
      },
    });
    await h.service.apply(on(["com.example.a"]));
    const restart = h.service.apply(on(["com.example.b"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.service.status()).toEqual({ status: "starting" });
    gate.resolve({ ok: true });
    await restart;
    expect(h.service.status()).toEqual({ status: "recording" });
  });

  it("killSync reaches a helper that is still stopping", async () => {
    // Codex #80 r1: process exit during a slow stop must still kill the helper.
    const h = harness();
    await h.service.apply(on());
    const hold = deferred();
    h.sup.holdStops(hold.promise);
    const stopping = h.service.apply(OFF);
    await new Promise((r) => setTimeout(r, 5));
    h.service.killSync();
    expect(h.sup.calls.map((c) => c.op)).toEqual(["start", "stop", "kill"]);
    hold.resolve();
    await stopping;
  });

  it("starts nothing when shutdown begins while a gate is pending", async () => {
    // Codex #80 r1 [P2]: the resumed apply used to start a helper and a new purge timer.
    const gate = deferred<{ ok: true }>();
    const h = harness({ purgeIntervalMs: 20, gates: { fileVault: () => gate.promise, backupExclusion: async () => ({ ok: true }) } });
    const applying = h.service.apply(on());
    await new Promise((r) => setTimeout(r, 5));
    const down = h.service.shutdown();
    gate.resolve({ ok: true });
    await Promise.all([applying, down]);
    expect(h.sup.calls).toEqual([]);
    const after = h.purges.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(h.purges.length).toBe(after);
  });

  it("starts nothing when the recorder is turned off while a gate is pending", async () => {
    const gate = deferred<{ ok: true }>();
    const h = harness({ gates: { fileVault: () => gate.promise, backupExclusion: async () => ({ ok: true }) } });
    const applying = h.service.apply(on());
    await new Promise((r) => setTimeout(r, 5));
    const off = h.service.apply(OFF);
    gate.resolve({ ok: true });
    await Promise.all([applying, off]);
    expect(h.sup.calls).toEqual([]);
    expect(h.service.status()).toEqual({ status: "off" });
  });

  it("shutdown stops a running helper", async () => {
    const h = harness();
    await h.service.apply(on());
    await h.service.shutdown();
    expect(h.sup.calls.map((c) => c.op)).toEqual(["start", "stop"]);
  });
});

describe("createQuitHold", () => {
  // Codex #80 r1: a second quit while the recorder is stopping used to fall through to the
  // backend shutdown before the final segment was stored.
  const event = () => {
    let prevented = false;
    return { preventDefault: () => void (prevented = true), prevented: () => prevented };
  };

  it("holds every quit until the recorder has stopped, then quits once", async () => {
    const stop = deferred();
    let stops = 0;
    let quits = 0;
    const hold = createQuitHold({
      stop: () => (stops++, stop.promise),
      quit: () => void quits++,
      log: () => {},
    });
    const first = event();
    const second = event();
    expect(hold(first)).toBe(true);
    expect(hold(second)).toBe(true);
    expect(first.prevented() && second.prevented()).toBe(true);
    expect(stops).toBe(1);
    stop.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(quits).toBe(1);
    const later = event();
    expect(hold(later)).toBe(false);
    expect(later.prevented()).toBe(false);
  });

  it("still quits, and logs, when the stop fails", async () => {
    const logs: string[] = [];
    let quits = 0;
    const hold = createQuitHold({
      stop: () => Promise.reject(new Error("helper wedged")),
      quit: () => void quits++,
      log: (m) => logs.push(m),
    });
    hold(event());
    await new Promise((r) => setTimeout(r, 0));
    expect(quits).toBe(1);
    expect(logs.join("\n")).toMatch(/helper wedged/);
  });
});
