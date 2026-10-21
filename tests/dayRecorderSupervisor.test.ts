import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createSupervisor,
  parseLine,
  type ScreenshotRow,
  type SegmentRow,
  type SupervisorOptions,
  type SupervisorState,
} from "../electron/dayRecorder.mjs";

// WHAT: the Day Recorder supervisor against a real child process (a fake gs-capture that
// speaks protocol v1), plan PR 3c. WHY a real process: every bug class this guards (a spawn
// error left to hang, an exit nobody noticed, a wedged helper) lives in the process plumbing
// a mock would replace. Pattern from the prebake spawn-error fix (PR #68).

const FAKE = path.join(__dirname, "fixtures", "day-recorder", "fake-gs-capture.mjs");
const SECRETS = /SYNTHETIC-(OCR|MALFORMED|V2|UNKNOWN)|com\.example\.denied/;

type Logged = string[];

function harness(scenario: string, overrides: Partial<SupervisorOptions> = {}) {
  const logs: Logged = [];
  const states: SupervisorState[] = [];
  const rows: ({ table: "screenshots"; args: ScreenshotRow } | { table: "captureSegments"; args: SegmentRow })[] = [];
  const supervisor = createSupervisor({
    command: process.execPath,
    prefixArgs: [FAKE],
    mediaRoot: "/tmp/gs-fake-media-root",
    env: { ...process.env, FAKE_SCENARIO: scenario },
    log: (message) => logs.push(message),
    onState: (s) => states.push(s),
    sink: {
      addScreenshot: async (args) => void rows.push({ table: "screenshots", args }),
      addSegment: async (args) => void rows.push({ table: "captureSegments", args }),
    },
    ...overrides,
  });
  return { supervisor, logs, states, rows };
}

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const live: ReturnType<typeof createSupervisor>[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop()));
});

function started(h: ReturnType<typeof harness>, denylist: string[] = []) {
  live.push(h.supervisor);
  h.supervisor.start({ denylist, shotSec: 30, segmentSec: 300 });
  return h;
}

describe("parseLine", () => {
  it("accepts a v1 line with a known event", () => {
    expect(parseLine('{"event":"heartbeat","t":5,"v":1}')).toEqual({
      ok: true,
      message: { event: "heartbeat", t: 5, v: 1 },
    });
  });

  it.each([
    ["not JSON", "nope SYNTHETIC-MALFORMED-SECRET"],
    ["another version", '{"event":"heartbeat","t":5,"v":2}'],
    ["an unknown event", '{"event":"mystery","v":1}'],
    ["a non-object", "[1,2]"],
    ["a shot without its fields", '{"event":"shot","v":1,"ocrText":"SYNTHETIC-OCR-SECRET"}'],
  ])("rejects %s, with a reason that never quotes the line", (_name, text) => {
    const result = parseLine(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toMatch(SECRETS);
  });
});

describe("Day Recorder supervisor", () => {
  it("reports Recording once the helper is ready, and Off after a clean stop", async () => {
    const h = started(harness("healthy"));
    await until(() => h.supervisor.state().status === "recording");
    await h.supervisor.stop();
    expect(h.supervisor.state()).toEqual({ status: "off" });
    expect(h.states.map((s) => s.status)).toEqual(["starting", "recording", "stopping", "off"]);
  });

  it("passes the media root, denylist and intervals on argv", async () => {
    const seen: string[][] = [];
    const h = started(
      harness("healthy", {
        spawnImpl: (cmd, args, opts) => {
          seen.push(args);
          return spawn(cmd, args, opts);
        },
      }),
      ["com.example.denied", "com.example.other"]
    );
    await until(() => h.supervisor.state().status === "recording");
    expect(seen[0]).toEqual([
      FAKE,
      "run",
      "--media-root",
      "/tmp/gs-fake-media-root",
      "--denylist",
      "com.example.denied,com.example.other",
      "--shot-sec",
      "30",
      "--segment-sec",
      "300",
    ]);
  });

  it("leaves out --denylist when the list is empty", async () => {
    const seen: string[][] = [];
    const h = started(
      harness("healthy", {
        spawnImpl: (cmd, args, opts) => {
          seen.push(args);
          return spawn(cmd, args, opts);
        },
      })
    );
    await until(() => h.supervisor.state().status === "recording");
    expect(seen[0]).not.toContain("--denylist");
  });

  it("refuses a denylist entry that is not a bundle id, before spawning", () => {
    const h = harness("healthy");
    expect(() => h.supervisor.start({ denylist: ["--evil"], shotSec: 30, segmentSec: 300 })).toThrow(
      /bundle id/
    );
    expect(h.states).toEqual([]);
  });

  it("surfaces a spawn error in under a second instead of hanging", async () => {
    const h = harness("healthy", { command: "/nonexistent/gs-capture", prefixArgs: [] });
    live.push(h.supervisor);
    const t0 = Date.now();
    h.supervisor.start({ denylist: [], shotSec: 30, segmentSec: 300 });
    await until(() => h.supervisor.state().status === "notRecording", 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    const s = h.supervisor.state();
    expect(s.status === "notRecording" && s.error.reason).toBe("spawnFailed");
  });

  it("goes to Not recording with the helper's own message when it fails", async () => {
    const h = started(harness("fail"));
    await until(() => h.supervisor.state().status === "notRecording");
    const s = h.supervisor.state();
    expect(s.status === "notRecording" && s.error).toEqual({
      reason: "exited",
      message: "Screen Recording permission was revoked",
      code: 3,
    });
  });

  it("treats an exit 0 without `stopped` as a failure", async () => {
    const h = started(harness("exit0"));
    await until(() => h.supervisor.state().status === "notRecording");
    const s = h.supervisor.state();
    expect(s.status === "notRecording" && s.error.reason).toBe("exited");
  });

  it("goes to Not recording and kills the helper after it falls silent", async () => {
    const h = started(harness("silent", { silentLimitMs: 300 }));
    await until(() => h.supervisor.state().status === "notRecording");
    const s = h.supervisor.state();
    expect(s.status === "notRecording" && s.error.reason).toBe("silent");
    await until(() => !h.supervisor.running());
  });

  it("drops malformed, wrong-version and unknown lines, logging none of their contents", async () => {
    const h = started(harness("malformed"));
    await until(() => h.logs.filter((l) => l.includes("dropped")).length >= 3);
    expect(h.supervisor.state().status).toBe("recording");
    expect(h.logs.join("\n")).not.toMatch(SECRETS);
  });

  it("stores shots and segments, omitting a null appBundleId, and never logs captured text", async () => {
    const h = started(harness("capture"));
    await until(() => h.rows.length === 3);
    expect(h.rows).toEqual([
      {
        table: "screenshots",
        args: {
          day: "2026-10-20",
          path: "2026-10-20/shot-101500-000.heic",
          takenAt: 1_760_969_700_000,
          ocrText: "SYNTHETIC-OCR-SECRET",
        },
      },
      {
        table: "screenshots",
        args: {
          day: "2026-10-20",
          path: "2026-10-20/shot-101530-000.heic",
          takenAt: 1_760_969_730_000,
          appBundleId: "com.example.editor",
          ocrText: "SYNTHETIC-OCR-TWO",
        },
      },
      {
        table: "captureSegments",
        args: {
          day: "2026-10-20",
          kind: "system",
          path: "2026-10-20/sys-101500-000.m4a",
          start: 1_760_969_700_000,
          end: 1_760_970_000_000,
        },
      },
    ]);
    await until(() => h.logs.some((l) => l.includes("tap rebuilt")));
    // tapRebuilt names denylisted bundles; the supervisor logs only its counts (protocol.md).
    expect(h.logs.join("\n")).not.toMatch(SECRETS);
  });

  it("logs a failed row write without the captured text and keeps recording", async () => {
    const h = started(
      harness("capture", {
        sink: {
          addScreenshot: async () => {
            throw new Error("backend down: SYNTHETIC-OCR-SECRET");
          },
          addSegment: async () => {},
        },
      })
    );
    await until(() => h.logs.some((l) => l.includes("could not store")));
    expect(h.supervisor.state().status).toBe("recording");
    expect(h.logs.join("\n")).not.toMatch(SECRETS);
  });

  it("escalates to SIGKILL when the helper ignores SIGTERM", async () => {
    const h = harness("stubborn", { stopGraceMs: 200 });
    h.supervisor.start({ denylist: [], shotSec: 30, segmentSec: 300 });
    await until(() => h.supervisor.state().status === "recording");
    await h.supervisor.stop();
    expect(h.supervisor.state()).toEqual({ status: "off" });
    expect(h.supervisor.running()).toBe(false);
    expect(h.logs.some((l) => l.includes("SIGKILL"))).toBe(true);
  });

  it("a stop before `ready` ends Off, not as a failure", async () => {
    const h = harness("healthy");
    h.supervisor.start({ denylist: [], shotSec: 30, segmentSec: 300 });
    await h.supervisor.stop();
    expect(h.supervisor.state()).toEqual({ status: "off" });
  });

  it("refuses a second start while one helper is running", async () => {
    const h = started(harness("healthy"));
    await until(() => h.supervisor.state().status === "recording");
    expect(() => h.supervisor.start({ denylist: [], shotSec: 30, segmentSec: 300 })).toThrow(/already/);
  });
});
