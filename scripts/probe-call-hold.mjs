#!/usr/bin/env node
// WHAT: live probe for the call hold (plan PR 4a, spec R5 / F3), on the real release helper
// and a real tap. A synthetic tone plays while `gs-capture run` is sent:
//   call hold → call release   (the released audio must come back as call- files that decode)
//   call hold → call discard   (nothing of the second call may reach disk)
// then it is stopped. The media root is a fresh temp folder, removed at the end; the probe
// prints counts, names and decode results only, never audio.
// WHY a probe, not a vitest suite: it needs the Swift helper, a tap and TCC, which CI (ubuntu)
// does not have; the same reason as probe:segment-decode.
// Usage: npm run build:gs-capture && node scripts/probe-call-hold.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const RELEASE = path.join(import.meta.dirname, "..", "native", "gs-capture", ".build", "release");
const HELPER = path.join(RELEASE, "gs-capture");
const TONE = path.join(RELEASE, "spike-tone");
const TONE_SEC = 40;
const STEP_MS = { settle: 3000, held: 5000, gap: 3000, discarded: 4000, after: 3000 };
const CALL_RATE = 16000;
// spike-tone plays at about 0.25 peak; well above the noise floor of an idle tap.
const MIN_TONE_PEAK = 0.05;
// The tap delivers 10 ms chunks; a boundary can fall inside one.
const CHUNK_MS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodes(file) {
  // afinfo ships with macOS and reads AAC .m4a; a file it can't parse fails the probe.
  const out = execFileSync("afinfo", [file], { encoding: "utf8" });
  const rate = Number(/(\d+) Hz/.exec(out)?.[1]);
  const seconds = Number(/estimated duration: ([\d.]+) sec/.exec(out)?.[1]);
  return { rate, seconds };
}

async function main() {
  for (const bin of [HELPER, TONE]) {
    if (!fs.existsSync(bin)) throw new Error(`${bin} is missing: run npm run build:gs-capture first`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-call-hold-"));
  const events = [];
  const tone = spawn(TONE, ["play", String(TONE_SEC), "440"], { stdio: "ignore" });
  const helper = spawn(HELPER, ["run", "--media-root", root, "--shot-sec", "3600", "--segment-sec", "300"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  helper.stderr.on("data", (d) => (stderr += d));
  readline.createInterface({ input: helper.stdout }).on("line", (text) => {
    const m = JSON.parse(text);
    // Shots carry OCR text: keep only the event name for them.
    events.push(m.event === "shot" ? { event: "shot", t: Date.now() } : { ...m, at: Date.now() });
  });
  const exited = new Promise((resolve) => helper.once("close", (code) => resolve(code)));
  const send = (command) => {
    events.push({ event: `> ${command}`, at: Date.now() });
    helper.stdin.write(`${command}\n`);
  };
  const waitFor = async (event, ms = 15000) => {
    const start = Date.now();
    while (!events.some((e) => e.event === event && e.at >= start - ms)) {
      if (Date.now() - start > ms) throw new Error(`no ${event} within ${ms} ms; stderr: ${stderr.trim()}`);
      await sleep(50);
    }
  };

  try {
    await waitFor("ready");
    await sleep(STEP_MS.settle);
    send("call hold");
    await waitFor("callHeld");
    await sleep(STEP_MS.held);
    send("call release");
    await waitFor("callReleased");
    await sleep(STEP_MS.gap);
    send("call hold");
    await sleep(STEP_MS.discarded);
    send("call discard");
    await waitFor("callDiscarded");
    await sleep(STEP_MS.after);
    helper.kill("SIGTERM");
    const code = await exited;
    tone.kill("SIGTERM");

    const segments = events.filter((e) => e.event === "segment");
    const calls = segments.filter((s) => s.kind === "call");
    const systems = segments.filter((s) => s.kind === "system");
    const released = events.find((e) => e.event === "callReleased");
    const discarded = events.find((e) => e.event === "callDiscarded");
    const firstHold = events.find((e) => e.event === "callHeld").at;
    // Each call's window, from its callHeld time to the moment its release/discard was sent.
    const held = events.filter((e) => e.event === "callHeld").map((e) => e.t);
    const ended = events.filter((e) => e.event === "> call release" || e.event === "> call discard").map((e) => e.at);
    const windows = held.map((t, i) => [t, ended[i]]);
    const files = fs.readdirSync(root, { recursive: true }).map(String);
    const callFiles = files.filter((f) => path.basename(f).startsWith("call-"));
    const partials = files.filter((f) => path.basename(f).startsWith(".partial-"));
    const decoded = calls.map((s) => ({ path: path.basename(s.path), ...decodes(path.join(root, s.path)) }));
    const checks = {
      exitedCleanly: code === 0,
      aSystemSegmentClosedAtTheHold: systems.some((s) => s.at <= firstHold + 1000),
      releasedAsCallSegments: calls.length >= 1 && released?.segments === calls.length,
      onlyReleasedCallFilesOnDisk: callFiles.length === calls.length,
      callFilesDecodeAt16k: decoded.length > 0 && decoded.every((d) => d.rate === CALL_RATE && d.seconds > 0),
      // The tone was playing, so the held audio is the tone, not silence.
      callAudioIsAudible: calls.every((s) => s.peak > MIN_TONE_PEAK),
      heldSecondsMatchTheFiles: Math.abs(decoded.reduce((a, d) => a + d.seconds, 0) - released.heldSec) < 0.5,
      discardedTheSecondCall: discarded?.reason === "command" && discarded.heldSec > 0,
      recordingResumedAfterRelease: systems.some((s) => s.at > released.at),
      noPartialsLeft: partials.length === 0,
      // Codex 4a r1: the tail still in the 500 ms hold-back must follow its call, so no sys-
      // segment may cover a call's time (beyond the 10 ms chunk a boundary falls in).
      noSystemAudioInsideACall: systems.every((s) => windows.every(([from, to]) => Math.min(s.end, to) - Math.max(s.start, from) <= CHUNK_MS)),
    };
    console.log(
      JSON.stringify(
        {
          checks,
          released: { segments: released.segments, heldSec: released.heldSec, overflowed: released.overflowed },
          discarded: { heldSec: discarded.heldSec, reason: discarded.reason },
          systemSegments: systems.length,
          callFiles: decoded.map((d, i) => ({ ...d, peak: calls[i].peak })),
        },
        null,
        2
      )
    );
    const failed = Object.entries(checks).filter(([, ok]) => !ok);
    if (failed.length) throw new Error(`failed: ${failed.map(([k]) => k).join(", ")}`);
    console.log("PASS");
  } finally {
    helper.kill("SIGKILL");
    tone.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`probe-call-hold: ${err.message}`);
  process.exit(1);
});
