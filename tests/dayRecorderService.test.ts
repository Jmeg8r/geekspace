import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// WHY fake timers for the whole file: these tests are about retry delays, purge intervals
// and ordering, and wall-clock waits of tens of ms failed on the shared CI runner (#80,
// runs on 2fa4d33..008a852). Advancing a fake clock makes every count exact.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

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
        await (holdStop ?? Promise.resolve());
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
    fail: (message: string, reason: "exited" | "silent" | "spawnFailed" | "protocol" = "exited") => {
      alive--;
      setCurrent?.({ status: "notRecording", error: { reason, message, code: 1 } });
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

const on = (denylist: string[] = [], shotSec = 30): RecorderSettings => ({
  enabled: true,
  paused: false,
  denylist,
  shotSec,
});
const OFF: RecorderSettings = { enabled: false, paused: false, denylist: [], shotSec: 30 };
const PAUSED: RecorderSettings = { ...on(), paused: true };

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
    await vi.advanceTimersByTimeAsync(0);
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

  it("starts retention when the service is created, before any settings arrive", async () => {
    // Codex #80 r3: a settings subscription that errors or never connects must not hold
    // retention back for the whole session (R14).
    const h = harness({ purgeIntervalMs: 20 });
    expect(h.purges).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(70);
    // One at creation, then at 20, 40 and 60 ms.
    expect(h.purges.length).toBe(4);
    await h.service.shutdown();
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
    await vi.advanceTimersByTimeAsync(70);
    // One at creation, then at 20, 40 and 60 ms.
    expect(h.purges.length).toBe(4);
    await h.service.shutdown();
    const after = h.purges.length;
    await vi.advanceTimersByTimeAsync(60);
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
    await vi.advanceTimersByTimeAsync(20);
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
    await vi.advanceTimersByTimeAsync(5);
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
    await vi.advanceTimersByTimeAsync(5);
    const down = h.service.shutdown();
    gate.resolve({ ok: true });
    await Promise.all([applying, down]);
    expect(h.sup.calls).toEqual([]);
    const after = h.purges.length;
    await vi.advanceTimersByTimeAsync(60);
    expect(h.purges.length).toBe(after);
  });

  it("starts nothing when the recorder is turned off while a gate is pending", async () => {
    const gate = deferred<{ ok: true }>();
    const h = harness({ gates: { fileVault: () => gate.promise, backupExclusion: async () => ({ ok: true }) } });
    const applying = h.service.apply(on());
    await vi.advanceTimersByTimeAsync(5);
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
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(quits).toBe(1);
    expect(logs.join("\n")).toMatch(/helper wedged/);
  });
});

describe("Day Recorder service, retry after a failure", () => {
  // Decision 2026-10-21: a bounded retry for a helper that exited or went silent, never for a
  // permission, spawn or protocol failure. Each retry is a capError event.
  const quick = { retryDelaysMs: [10, 10, 10], retryResetMs: 1000 };
  const starts = (h: ReturnType<typeof harness>) => h.sup.calls.filter((c) => c.op === "start").length;
  const tick = (ms = 30) => vi.advanceTimersByTimeAsync(ms);

  it("retries an exited helper up to three times, then stays Not recording", async () => {
    const h = harness(quick);
    await h.service.apply(on());
    for (let i = 0; i < 4; i++) {
      h.sup.fail("helper crashed");
      await tick();
    }
    expect(starts(h)).toBe(4);
    expect(h.service.status().status).toBe("notRecording");
    expect(h.events.filter((e) => e.detail?.startsWith("retry"))).toHaveLength(3);
    expect(h.events.at(-1)?.detail).toMatch(/^no more retries/);
    await h.service.shutdown();
  });

  it("retries a helper that went silent", async () => {
    const h = harness(quick);
    await h.service.apply(on());
    h.sup.fail("gs-capture said nothing for 10 s", "silent");
    await tick();
    expect(starts(h)).toBe(2);
    await h.service.shutdown();
  });

  it.each([
    ["a revoked permission", "SCShareableContent failed (Screen Recording permission?): denied", "exited"],
    // Codex #80 final check: the native TCC denial wording (spike evidence) has no "permission".
    ["a TCC denial", "captureImage failed: The user declined TCCs for application, window, display capture", "exited"],
    ["a spawn failure", "couldn't start gs-capture: ENOENT", "spawnFailed"],
    ["a protocol violation", "gs-capture broke protocol v1 (not JSON)", "protocol"],
  ] as const)("does not retry %s", async (_name, message, reason) => {
    const h = harness(quick);
    await h.service.apply(on());
    h.sup.fail(message, reason);
    await tick();
    expect(starts(h)).toBe(1);
    expect(h.service.status().status).toBe("notRecording");
    await h.service.shutdown();
  });

  it("shows when the next retry is due", async () => {
    const h = harness({ retryDelaysMs: [500], retryResetMs: 1000 });
    await h.service.apply(on());
    h.sup.fail("helper crashed");
    await tick(0);
    expect(h.service.status()).toMatchObject({ status: "notRecording", error: "helper crashed", retryInMs: 500 });
    await h.service.shutdown();
  });

  it("cancels a pending retry when the recorder is turned off", async () => {
    const h = harness({ retryDelaysMs: [40], retryResetMs: 1000 });
    await h.service.apply(on());
    h.sup.fail("helper crashed");
    await h.service.apply(OFF);
    await tick(80);
    expect(starts(h)).toBe(1);
    expect(h.service.status()).toEqual({ status: "off" });
  });

  it("cancels a pending retry at shutdown", async () => {
    const h = harness({ retryDelaysMs: [40], retryResetMs: 1000 });
    await h.service.apply(on());
    h.sup.fail("helper crashed");
    await h.service.shutdown();
    await tick(80);
    expect(starts(h)).toBe(1);
  });

  it("resets the retry budget after a run that stayed up", async () => {
    const h = harness({ retryDelaysMs: [10, 10, 10], retryResetMs: 50 });
    await h.service.apply(on());
    for (let i = 0; i < 3; i++) {
      h.sup.fail("helper crashed");
      await tick();
    }
    await tick(80);
    h.sup.fail("helper crashed");
    await tick();
    expect(starts(h)).toBe(5);
    await h.service.shutdown();
  });
});

describe("Day Recorder service, pause", () => {
  // Decision 2026-10-31 (James): pause is a saved setting, so a paused recorder stays paused
  // across a relaunch or crash. Pause stops the helper but leaves the recorder enabled.
  const starts = (h: ReturnType<typeof harness>) => h.sup.calls.filter((c) => c.op === "start").length;
  const tick = (ms = 30) => vi.advanceTimersByTimeAsync(ms);

  it("starts nothing when the saved settings are paused, as after a relaunch", async () => {
    const h = harness();
    await h.service.apply(PAUSED);
    expect(h.sup.calls).toEqual([]);
    expect(h.service.status()).toEqual({ status: "paused" });
  });

  it("stops a running helper on pause and starts it again on resume", async () => {
    const h = harness();
    await h.service.apply(on());
    await h.service.apply(PAUSED);
    expect(h.sup.calls.map((c) => c.op)).toEqual(["start", "stop"]);
    expect(h.service.running()).toBe(false);
    expect(h.service.status()).toEqual({ status: "paused" });
    await h.service.apply(on());
    expect(starts(h)).toBe(2);
    expect(h.service.status()).toEqual({ status: "recording" });
  });

  it("reports off, not paused, when the recorder is turned off while paused", async () => {
    const h = harness();
    await h.service.apply({ ...OFF, paused: true });
    expect(h.service.status()).toEqual({ status: "off" });
  });

  it("does not retry a failed helper once the recorder is paused", async () => {
    const h = harness({ retryDelaysMs: [10], retryResetMs: 1000 });
    await h.service.apply(on());
    h.sup.fail("helper crashed");
    await h.service.apply(PAUSED);
    await tick(80);
    expect(starts(h)).toBe(1);
    expect(h.service.status()).toEqual({ status: "paused" });
  });

  it("starts nothing when pause arrives while a gate is pending", async () => {
    // Codex #88 r1 [P2]: pause has to land while the start is inside its gate, not before
    // the start has begun, or the test passes on an implementation that ignores it.
    const gate = deferred<{ ok: true }>();
    const entered = deferred();
    const h = harness({
      gates: {
        fileVault: () => {
          entered.resolve();
          return gate.promise;
        },
        backupExclusion: async () => ({ ok: true }),
      },
    });
    const first = h.service.apply(on());
    await entered.promise;
    expect(h.service.status()).toEqual({ status: "starting" });
    const second = h.service.apply(PAUSED);
    gate.resolve({ ok: true });
    await Promise.all([first, second]);
    expect(starts(h)).toBe(0);
    expect(h.service.status()).toEqual({ status: "paused" });
  });
});

describe("Day Recorder service, mic state", () => {
  // Decision 2026-10-31 (James): a mic failure degrades loudly. Screens and system audio carry
  // on, and the Recording status carries the mic's own state, so nothing claims a full recording.
  it("carries the mic's state on Recording and tells listeners", async () => {
    const h = harness();
    const seen: string[] = [];
    h.service.onStatus((s) => void seen.push(JSON.stringify(s)));
    await h.service.apply(on());
    h.service.setMic({ state: "error", kind: "denied", error: "Microphone access is off for Geekspace." });
    expect(h.service.status()).toEqual({
      status: "recording",
      mic: { state: "error", kind: "denied", error: "Microphone access is off for Geekspace." },
    });
    expect(seen.at(-1)).toContain('"mic"');
    expect(h.service.running()).toBe(true);
  });

  it("does not repeat Recording when the mic's state has not changed", async () => {
    const h = harness();
    await h.service.apply(on());
    h.service.setMic({ state: "ok" });
    const seen: string[] = [];
    h.service.onStatus((s) => void seen.push(JSON.stringify(s)));
    h.service.setMic({ state: "ok" });
    expect(seen).toEqual([]);
    h.service.setMic({ state: "silent", silentSec: 25 });
    expect(seen).toHaveLength(1);
  });

  it("leaves the mic out of every status but Recording", async () => {
    const h = harness();
    h.service.setMic({ state: "ok" });
    expect(h.service.status()).toEqual({ status: "off" });
    await h.service.apply(on());
    expect(h.service.status()).toEqual({ status: "recording", mic: { state: "ok" } });
    await h.service.apply(PAUSED);
    expect(h.service.status()).toEqual({ status: "paused" });
  });
});
