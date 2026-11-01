// WHAT: the Day Recorder supervisor (plan PR 3c). Spawns `gs-capture run`, reads its JSON
// lines (protocol v1, docs/changes/2026-10-18-day-recorder/protocol.md), stores each shot
// and segment through the sink, and reports whether capture is really live.
// WHY this much care: spec R3 says a helper that exits, wedges or loses a permission must
// show "Not recording" within 10 s. Every way the helper can end is a state change here,
// never a silent stall. Captured content (OCR text, denylisted bundle ids) never reaches a log.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

export const PROTOCOL_VERSION = 1;
// protocol.md "Failure": no line at all (heartbeats come every 5 s) for more than 10 s.
export const SILENT_LIMIT_MS = 10_000;
// The helper settles its held tail within a 5 s deadline on SIGTERM, then finalizes the
// open segment; past this it is wedged and gets SIGKILL.
export const STOP_GRACE_MS = 8_000;
// How long a stop waits for row writes still in flight (the final segment's, mostly) before
// the caller closes the Convex client and the backend.
export const DRAIN_MS = 5_000;
const MAX_STDERR_CHARS = 500;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isStr = (x) => typeof x === "string";
const isBool = (x) => typeof x === "boolean";

// The fields each event must carry before the supervisor acts on it. Events the supervisor
// only logs or ignores need just their name.
const SHAPES = {
  ready: (m) => isNum(m.pid),
  heartbeat: (m) => isNum(m.t),
  shot: (m) =>
    isStr(m.day) && isStr(m.path) && isNum(m.takenAt) && isStr(m.ocrText) && (m.appBundleId === null || isStr(m.appBundleId)),
  segment: (m) => (m.kind === "system" || m.kind === "call") && isStr(m.day) && isStr(m.path) && isNum(m.start) && isNum(m.end),
  // The call hold (plan PR 4a): counts and a fixed reason only, never audio.
  callHeld: (m) => isNum(m.t),
  callReleased: (m) => isNum(m.segments) && isNum(m.heldSec) && isBool(m.overflowed),
  callDiscarded: (m) => isNum(m.heldSec) && (m.reason === "command" || m.reason === "stop"),
  // These are only logged, but what is logged is validated too (Codex #80 r2): counts must
  // be numbers and `trigger` one of its two values, so no line can smuggle text into a log.
  tapRebuilt: (m) =>
    (m.trigger === "listener" || m.trigger === "poll") && isNum(m.droppedWindows) && isNum(m.addedProcesses) && isNum(m.rebuildMs),
  tailDropped: (m) => isNum(m.droppedWindows) && isBool(m.unjudged),
  sampleRateChanged: (m) => isNum(m.from) && isNum(m.to),
  sessionUnverified: (m) => isNum(m.livedMs),
  audioUse: (m) => (m.app === null || isStr(m.app)) && isBool(m.denylisted) && isBool(m.input) && isBool(m.output),
  stopped: (m) => isStr(m.reason),
};

/**
 * Parse one stdout line. A rejection's reason names what was wrong, never what the line
 * said, so it is safe to log.
 */
export function parseLine(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, reason: "not a JSON object" };
  }
  if (message.v !== PROTOCOL_VERSION) return { ok: false, reason: "wrong protocol version" };
  const shape = Object.hasOwn(SHAPES, message.event) ? SHAPES[message.event] : null;
  if (!shape) return { ok: false, reason: "unknown event" };
  if (!shape(message)) return { ok: false, reason: `malformed ${message.event} event` };
  return { ok: true, message };
}

// Counts only: tapRebuilt and tailDropped name denylisted bundles in their diagnostic fields,
// and logging those would undo shot's and audioUse's anonymity (protocol.md).
function diagnostic(m) {
  switch (m.event) {
    case "tapRebuilt":
      return `tap rebuilt (${m.trigger}): dropped ${m.droppedWindows} windows, ${m.addedProcesses} processes added, ${m.rebuildMs} ms`;
    case "tailDropped":
      return `held tail dropped at stop: ${m.droppedWindows} windows${m.unjudged ? ", unjudged" : ""}`;
    case "sampleRateChanged":
      return `system audio sample rate changed from ${m.from} to ${m.to}`;
    case "sessionUnverified":
      return `a tap session ended after ${m.livedMs} ms, before its first IO cycle`;
    case "callHeld":
      return "call audio held";
    case "callReleased":
      return `call audio released: ${m.segments} segment(s), ${m.heldSec} s${m.overflowed ? ", the hold was full" : ""}`;
    case "callDiscarded":
      return `call audio discarded: ${m.heldSec} s (${m.reason})`;
    default:
      return null;
  }
}

/**
 * The recorder's append-only log file. A stream error (the file can't be opened, the disk is
 * full) would otherwise be an uncaught exception in the main process; instead it is reported
 * once through `fallback`, which then takes every later line.
 */
export function createFileLog(file, fallback = (message) => console.error(message)) {
  let broken = false;
  const stream = fs.createWriteStream(file, { flags: "a" });
  stream.on("error", (err) => {
    if (broken) return;
    broken = true;
    fallback(`Day Recorder log ${file} failed (${err?.code ?? err}); logging to the console instead`);
  });
  return {
    log(message) {
      const line = `${new Date().toISOString()} ${message}`;
      if (broken) fallback(line);
      else stream.write(`${line}\n`);
    },
    end() {
      if (!broken) stream.end();
    },
  };
}

/**
 * A logger for the main-process Convex client. The client logs a failed mutation's server
 * error before the promise rejects, and an argument-validation error echoes the arguments,
 * OCR text included. So only the fact and the level are kept.
 */
export function contentFreeLogger(log) {
  const withheld = (level) => () => log(`convex client ${level} (details withheld: they can include captured content)`);
  return { log: () => {}, logVerbose: () => {}, warn: withheld("warn"), error: withheld("error") };
}

export function createSupervisor({
  command,
  prefixArgs = [],
  mediaRoot,
  sink,
  log,
  onState,
  // audioUse lines, for call detection and the room-mic pause (plan PR 4b).
  onAudioUse = () => {},
  env = process.env,
  spawnImpl = spawn,
  silentLimitMs = SILENT_LIMIT_MS,
  stopGraceMs = STOP_GRACE_MS,
  drainMs = DRAIN_MS,
}) {
  let state = { status: "off" };
  let child = null;
  let exited = Promise.resolve();
  let stopRequested = false;
  let sawStopped = false;
  // The notice events of released calls whose audio has not all arrived, oldest first. The
  // helper settles calls in order, so each call segment belongs to the first (Codex #4a r1).
  let releasing = [];
  let lastStderr = "";
  let silenceTimer = null;
  const pending = new Set();

  function setState(next) {
    state = next;
    onState(next);
  }

  function clearSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  function armSilence(proc) {
    clearSilence();
    silenceTimer = setTimeout(() => {
      fail({ reason: "silent", message: `gs-capture said nothing for ${Math.round(silentLimitMs / 1000)} s` });
      // A wedged helper may never answer SIGTERM (a hung ScreenCaptureKit call, spike Q1).
      proc.kill("SIGKILL");
    }, silentLimitMs);
  }

  function fail(error) {
    clearSilence();
    if (stopRequested || state.status === "notRecording") return;
    log(`Not recording: ${error.reason}: ${error.message}`);
    setState({ status: "notRecording", error });
  }

  function store(kind, write, args) {
    // WHY not the error's message: a Convex argument-validation error echoes the arguments,
    // and a screenshot's include its OCR text. The path is enough to find the file.
    const p = write(args)
      .catch((err) =>
        log(`could not store a ${kind} row for ${args.path} (${err?.name ?? "Error"}); the file stays until the retention sweep`)
      )
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  async function drain() {
    if (pending.size === 0) return;
    let timer;
    const done = await Promise.race([
      Promise.allSettled([...pending]).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), drainMs);
      }),
    ]);
    clearTimeout(timer);
    if (!done) {
      const n = pending.size;
      log(`${n} row write${n === 1 ? "" : "s"} still pending after ${drainMs} ms; their files stay until the retention sweep`);
    }
  }

  /** Stop a helper that broke the protocol: SIGTERM finalizes its segment, SIGKILL if it won't. */
  function terminate(proc) {
    proc.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child === proc) proc.kill("SIGKILL");
    }, stopGraceMs);
    proc.once("close", () => clearTimeout(timer));
  }

  function onLine(proc, text) {
    // After a failure the watchdog has done its job; lines still arriving (a final segment)
    // are stored, but they don't make the helper healthy again.
    if (state.status !== "notRecording") armSilence(proc);
    const parsed = parseLine(text);
    if (!parsed.ok) {
      log(`dropped a helper line: ${parsed.reason}`);
      // protocol.md "Failure": such a line means Not recording, not just a dropped line.
      if (state.status !== "notRecording" && !stopRequested) {
        fail({ reason: "protocol", message: `gs-capture broke protocol v1 (${parsed.reason})` });
        terminate(proc);
      }
      return;
    }
    const m = parsed.message;
    switch (m.event) {
      case "ready":
        log(`gs-capture ready (pid ${m.pid})`);
        if (state.status === "starting") setState({ status: "recording" });
        return;
      case "shot":
        store("screenshot", sink.addScreenshot, {
          day: m.day,
          path: m.path,
          takenAt: m.takenAt,
          // protocol.md: null is stored by omitting the field, never by guessing.
          ...(m.appBundleId !== null && { appBundleId: m.appBundleId }),
          ocrText: m.ocrText,
        });
        return;
      case "segment": {
        const row = { day: m.day, kind: m.kind, path: m.path, start: m.start, end: m.end };
        if (m.kind === "call") {
          // Spec R5: call audio is stored only with the notice that released it. A call segment
          // nobody released means the helper broke the hold, so capture stops over it.
          if (releasing.length === 0) {
            if (state.status !== "notRecording" && !stopRequested) {
              fail({ reason: "protocol", message: "gs-capture announced call audio that was never released" });
              terminate(proc);
            }
            return;
          }
          row.noticeEventId = releasing[0];
        }
        store("segment", sink.addSegment, row);
        return;
      }
      case "callReleased":
        releasing.shift();
        log(diagnostic(m));
        return;
      case "stopped":
        sawStopped = true;
        return;
      case "audioUse":
        onAudioUse(m);
        return;
      default: {
        const line = diagnostic(m);
        if (line) log(line);
      }
    }
  }

  function onExit(proc, code, signal) {
    if (child !== proc) return;
    child = null;
    clearSilence();
    if (stopRequested) return;
    const why = lastStderr || `gs-capture ${sawStopped ? "stopped on its own" : "exited without saying why"} (code ${code}, signal ${signal})`;
    fail({ reason: "exited", message: why, code });
  }

  function start({ denylist, shotSec, segmentSec, startHeld = false }) {
    if (child) throw new Error("A gs-capture helper is already running");
    for (const id of denylist) {
      if (!BUNDLE_ID_RE.test(id)) throw new Error(`Denylist entry is not a bundle id: ${JSON.stringify(id)}`);
    }
    const args = [
      ...prefixArgs,
      "run",
      "--media-root",
      mediaRoot,
      ...(denylist.length > 0 ? ["--denylist", denylist.join(",")] : []),
      "--shot-sec",
      String(shotSec),
      "--segment-sec",
      String(segmentSec),
      // A call waits for its notice or was declined: hold from the first sample (plan PR 4b).
      ...(startHeld ? ["--start-held", "yes"] : []),
    ];
    stopRequested = false;
    sawStopped = false;
    lastStderr = "";
    setState({ status: "starting" });

    let proc;
    try {
      // stdin carries the call-hold commands (protocol.md "Commands").
      proc = spawnImpl(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      fail({ reason: "spawnFailed", message: `couldn't start gs-capture: ${err?.message ?? err}` });
      return;
    }
    child = proc;
    releasing = [];
    // A broken command channel means a hold may never reach the helper, which would then go
    // on writing call audio as system audio: capture stops (Codex #4a r1). After an exit this
    // is the exit's echo, already handled.
    proc.stdin?.on("error", (err) => {
      if (child !== proc) return;
      fail({ reason: "protocol", message: `the command channel to gs-capture broke (${err?.code ?? "error"})` });
      terminate(proc);
    });
    exited = new Promise((resolve) => {
      proc.once("close", (code, signal) => {
        onExit(proc, code, signal);
        resolve();
      });
      // WHY: a spawn failure (missing binary, no exec permission) emits "error". Without
      // this listener it is thrown at the process level or left to hang (PR #68's bug).
      proc.once("error", (err) => {
        if (proc.pid !== undefined) {
          log(`gs-capture process error: ${err?.message ?? err}`);
          return;
        }
        if (child === proc) child = null;
        fail({ reason: "spawnFailed", message: `couldn't start gs-capture: ${err?.message ?? err}` });
        resolve();
      });
    });

    readline.createInterface({ input: proc.stdout }).on("line", (text) => onLine(proc, text));
    readline.createInterface({ input: proc.stderr }).on("line", (text) => {
      // protocol.md: the helper's failures are "gs-capture: <message>" lines on stderr.
      if (text.startsWith("gs-capture: ")) lastStderr = text.slice("gs-capture: ".length, MAX_STDERR_CHARS);
    });
    armSilence(proc);
  }

  async function stop() {
    const proc = child;
    if (!proc) {
      clearSilence();
      await drain();
      if (state.status !== "off") setState({ status: "off" });
      return;
    }
    stopRequested = true;
    clearSilence();
    setState({ status: "stopping" });
    proc.kill("SIGTERM");
    let timer;
    const gaveUp = await Promise.race([
      exited.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), stopGraceMs);
      }),
    ]);
    clearTimeout(timer);
    if (gaveUp) {
      log(`gs-capture did not stop within ${stopGraceMs} ms; sending SIGKILL`);
      proc.kill("SIGKILL");
      await exited;
    }
    if (!sawStopped && !gaveUp) log("gs-capture exited on SIGTERM before it reported stopped");
    await drain();
    setState({ status: "off" });
  }

  /** One call-hold command to the helper (protocol.md "Commands"). */
  function sendCommand(line) {
    if (!child?.stdin?.writable) throw new Error("The capture helper is not running");
    child.stdin.write(`${line}\n`);
  }

  return {
    start,
    stop,
    /** A call started: the helper holds system audio in memory from here (spec R5). */
    holdCall: () => sendCommand("call hold"),
    /** The notice was given: the held audio is written and stored with this notice event. */
    releaseCall(noticeEventId) {
      sendCommand("call release");
      releasing.push(noticeEventId);
    },
    /** Declined or timed out: the held audio is dropped unwritten. */
    discardCall: () => sendCommand("call discard"),
    state: () => state,
    running: () => child !== null,
    /** Last resort for process exit: no time to finalize the open segment. */
    killSync() {
      child?.kill("SIGKILL");
    },
  };
}
