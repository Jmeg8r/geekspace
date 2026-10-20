// WHAT: Day Recorder PR 1 spike driver. Each subcommand answers one question from
// docs/changes/2026-10-18-day-recorder/plan.md and prints a JSON result; the evidence is
// recorded in that folder's spike-findings.md.
// WHY: the spec rests on claims that are marked unverified (F1, F2, F4, F8, entitlements).
// A script makes every number re-runnable on the Mac Studio instead of a one-off reading.
// Media goes to GS_SPIKE_DIR (default: a temp dir), never into the repo: real screen and
// audio captures from this machine are private, and the repo is public. Output never
// contains OCR text from real frames, only counts and whether a synthetic canary was seen.
// macOS only; needs Screen Recording (and Microphone for `procwatch`) for the calling app.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = path.join(ROOT, "native", "gs-capture");
const RELEASE_DIR = path.join(PACKAGE_DIR, ".build", "release");
const OUT_DIR = process.env.GS_SPIKE_DIR ?? path.join(os.tmpdir(), "gs-spike");
const HELPER = process.env.GS_CAPTURE_BIN ?? path.join(RELEASE_DIR, "gs-capture");
const OCR_FIXTURES = path.join(ROOT, "tests", "fixtures", "day-recorder", "ocr-fixtures.json");
const TONE_BUNDLE_ID = "dev.geekspace.spike.tone";
const TONE_APP = path.join(OUT_DIR, "SpikeTone.app");
const TEXTEDIT_BUNDLE_ID = "com.apple.TextEdit";
const FINDER_BUNDLE_ID = "com.apple.finder";
const ELECTRON_BUNDLE_ID = "com.github.Electron";
const WEB_TONE_SECONDS = 10;
const CANARY = "SYNTHETIC-DENYLIST-CANARY-7Q4X";
const BACKDROP_PAD_PT = 120;
const BACKDROP_SECONDS = 20;

const WINDOW_SETTLE_MS = 2_500;
const TONE_SECONDS = 8;
const TONE_HZ = 440;
const AUDIO_SECONDS = 4;
const TONE_WARMUP_MS = 1_500;
const LATE_LAUNCH_MS = 2_000;
const TONE_LOG_GRACE_MS = 5_000;
const TONE_LOG_POLL_MS = 200;
const CAPTURE_LIVE_TIMEOUT_MS = 15_000;
const FOLLOW_MS = 200;
// Anything above -60 dBFS in a 100 ms window counts as leaked tone.
const LEAK_RMS = 0.001;
// PR 3b-1 run-menubar proof.
const RUN_SHOT_SEC = 2;
const RUN_SECONDS = 5;
// PR 3b-2 run-segments proof: instance 2 starts at RUN_SEG_SECOND_MS (forcing a rebuild),
// the non-denylisted control at RUN_SEG_CONTROL_MS, and SIGTERM ends the run.
const RUN_SEGMENT_SEC = 3;
const RUN_SEG_SECOND_MS = 2_000;
const RUN_SEG_CONTROL_MS = 3_500;
const RUN_SEG_STOP_MS = 9_000;
const RUN_SEG_SHOT_SEC = 60;
// A gated sine's onset and offset click is broadband, so it reads at 440 Hz too (measured:
// 0.004 at 440 Hz with 0.006 at 520 Hz, at the control tone's edges). A leak window must
// carry 440 Hz this many times above the louder of two bands neither tone uses. A real leak
// (amplitude 0.25 against a near-zero floor) passes this easily, even on top of a click.
const TONAL_RATIO = 3;
const REFERENCE_HZ = [370, 520];
// PR 3b-2 Codex P1 proof: polls far apart, and a second instance that lives well inside one
// interval, so only the arrivals listener can see it.
const TRANSIENT_POLL_MS = 2_500;
const TRANSIENT_HOLD_MS = TRANSIENT_POLL_MS * 2;
const TRANSIENT_TAP_SECONDS = 6;
const TRANSIENT_START_MS = 600;
const TRANSIENT_PLAY_SECONDS = 0.4;
const SLOW_CLASSIFIER = { pollMs: 700, holdMs: 1_500, playSeconds: 0.1, classifyDelayMs: 2_200 };
// The orphan child plays this long; the parent exits 0.8 s after spawning it (spike-tone).
const ORPHAN = { tapSeconds: 9, startMs: 300, childSeconds: 5, controlMs: 7_000, minOrphanMs: 2_000,
  // Baseline variant: the parent lives this long, and the unrelated trigger instance starts
  // this long after the tap is live (after the parent has exited).
  baselineParentSeconds: 2, triggerMs: 2_800 };
// A plays (silently) through the whole run; B launches this long after A starts.
const B_DURING_A = { aSeconds: 8, bAfterAMs: 300 };
const TRANSIENT_CONTROL_MS = 3_500;
// The control tone keeps sounding briefly after it logs "stopped" (output latency). Measured
// across 8 tap runs: every stray window ended 103-128 ms after that log, never later. Windows
// in this tail count as the control and are reported as controlTail, not hidden.
const CONTROL_TAIL_MS = 150;
const MENU_BAR_PT = 30; // measured: the menu bar is 0,0 1920x30 points on the Mac Studio's display
const DISPLAY_WIDTH_PT = 1920;
const BAND_BLACK_LUMA = 2; // a blanked band is painted black
const BAND_CONTENT_LUMA = 20; // anything on screen reads well above black
// The tap meters 100 ms windows (Tap.swift), each stamped when it completes.
const WINDOW_MS = 100;
// PR 3a control tone: starts this long after instance 2, well after a rebuild finishes.
const CONTROL_DELAY_MS = 1_500;
const CONTROL_SECONDS = 1;
const CONTROL_HZ = 660;
const PROCWATCH_SECONDS = 16;
const PROC_PHASE_SECONDS = 3;
const PROC_GAP_MS = 2_000;
const PROC_POLL_MS = 100;
const PROC_COST_SECONDS = 60;
const SHOT_INTERVALS_SEC = [15, 30, 60];
const SECONDS_PER_HOUR = 3_600;
const WORK_HOURS_PER_DAY = 8;
const RETENTION_DAYS = 30;
const BYTES_PER_MB = 1_000_000;
const AUDIO_OPUS_KBPS = 32;
const WHISPER_MODELS = ["ggml-base.en.bin", "ggml-small.en.bin"];
const WHISPER_MODEL_DIR = path.join(os.homedir(), ".geekspace", "whisper-models");
const SPEECH_SAMPLE_RATE = 16_000;
// Pink noise at this amplitude is ~-22 dB mean against ~-16 dB `say` speech: ~6 dB SNR
// (measured with ffmpeg volumedetect, spike-findings.md Q6).
const NOISE_AMPLITUDE = 0.4;
const OCR_SCALES = [1, 2];
// Deliberately NOT shaped like a real key (so secret scanners don't flag it): any value in
// ANTHROPIC_API_KEY is enough to see which credential the SDK chooses to send.
const FAKE_API_KEY = "spike-fake-key-not-a-credential";
const SDK_PROBE_TIMEOUT_MS = 90_000;
const GAP_SEGMENTS = 6;
const GAP_SEGMENT_MS = 5_000;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * BYTES_PER_MB, ...opts });
  if (result.error) throw new Error(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${result.status}: ${String(result.stderr).trim().slice(0, 2_000)}`);
  }
  return result.stdout;
}

const jsonLines = (text) => text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
const helper = (...args) => jsonLines(run(HELPER, args.map(String)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, places = 2) => Number(value.toFixed(places));

function save(name, result) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

/** Resolves once a background helper has printed its "started" line (capture is live). */
async function captureLive(handle, timeoutMs = CAPTURE_LIVE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.lines.some((line) => ["started", "watching", "ready"].includes(line.event))) return;
    await sleep(TONE_LOG_POLL_MS / 4);
  }
  throw new Error(`capture did not report started within ${timeoutMs} ms`);
}

/**
 * Start a helper subcommand in the background, collecting its JSON lines. With `logFile`,
 * every line is also appended to disk as it arrives, so a long run that dies or hangs
 * still leaves its data behind (lesson from the first, lost, one-hour shots run).
 */
function background(args, logFile) {
  if (logFile) fs.writeFileSync(logFile, "");
  const child = spawn(HELPER, args.map(String), { stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let stderr = "";
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop();
    for (const part of parts) {
      if (!part.trim()) continue;
      lines.push(JSON.parse(part));
      if (logFile) fs.appendFileSync(logFile, `${part}\n`);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    // `close`, not `exit`: exit can fire before stdout/stderr drain, which would hand the
    // caller a result missing its last lines (Codex review of PR 71).
    child.on("close", (code) => (code === 0 ? resolve(lines) : reject(new Error(`gs-capture ${args[0]} exited ${code}: ${stderr.trim()}`))));
  });
  return { lines, done, child };
}

/**
 * Per-100 ms amplitude of `hz` in mono 16 kHz samples: a Hann-windowed Goertzel, so a tone
 * 220 Hz away (the control) does not read as this one through spectral leakage.
 */
function toneAmplitudes(samples, hz, rate = SPEECH_SAMPLE_RATE) {
  const n = rate * WINDOW_MS / 1000;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
  const out = [];
  for (let start = 0; start + n <= samples.length; start += n) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const s0 = samples[start + i] * hann + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    // Hann's coherent gain is 0.5, so a full-scale sine of amplitude A reads A.
    out.push((2 * Math.sqrt(Math.max(power, 0))) / (n * 0.5));
  }
  return out;
}

/** Launch the stand-in app as its own responsible process; its JSON lines land in a file. */
function launchTone(mode, seconds, tag, extra = [TONE_HZ]) {
  const log = path.join(OUT_DIR, `tone-${tag}.jsonl`);
  fs.rmSync(log, { force: true });
  run("open", ["-n", "-g", "--stdout", log, "--stderr", log, TONE_APP, "--args", mode, String(seconds), ...extra.map(String)]);
  return log;
}

/**
 * SpikeTone run as a bare executable: no bundle ID and a non-denylisted parent, so a tap
 * that excludes the tone app must still capture it. The PR 3a positive control.
 */
function bareTone(seconds, tag, hz) {
  const log = path.join(OUT_DIR, `tone-${tag}.jsonl`);
  fs.rmSync(log, { force: true });
  const fd = fs.openSync(log, "a");
  const child = spawn(path.join(RELEASE_DIR, "spike-tone"), ["play", String(seconds), String(hz)], { stdio: ["ignore", fd, fd] });
  child.on("error", (error) => { throw error; });
  fs.closeSync(fd);
  return log;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const readTone = (log) => (fs.existsSync(log) ? jsonLines(fs.readFileSync(log, "utf8")) : []);

/**
 * Start the Electron WebAudio tone. `interval` resolves with when it was audible
 * ({startT, stopT}), and rejects unless it reported playback start and exited 0.
 */
function electronTone(seconds) {
  const child = spawn(path.join(ROOT, "node_modules", ".bin", "electron"), [path.join(ROOT, "scripts", "spike", "web-tone.cjs")], {
    env: { ...process.env, GS_TONE_SECONDS: String(seconds) }, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const interval = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`electron tone exited ${code}`));
      const events = jsonLines(out);
      const started = events.find((event) => event.event === "started");
      const stopped = events.find((event) => event.event === "stopped");
      if (!started || !stopped) return reject(new Error("electron tone did not report both playback start and stop"));
      resolve({ startT: started.t, stopT: stopped.t });
    });
  });
  return { interval };
}

/** SpikeTone's audible interval, from its own log, once it has logged "stopped". */
async function spikeToneInterval(log, seconds) {
  const deadline = Date.now() + seconds * 1000 + TONE_LOG_GRACE_MS;
  while (Date.now() < deadline) {
    const events = readTone(log);
    const started = events.find((event) => event.event === "started");
    const stopped = events.find((event) => event.event === "stopped");
    if (started && stopped) return { startT: started.t, stopT: stopped.t, pid: started.pid };
    await sleep(TONE_LOG_POLL_MS);
  }
  throw new Error(`SpikeTone did not log both start and stop (${path.basename(log)})`);
}

/** Waits for a SpikeTone log's "started" line and returns its pid. */
async function waitForToneStart(log) {
  const deadline = Date.now() + TONE_LOG_GRACE_MS;
  while (Date.now() < deadline) {
    const started = readTone(log).find((event) => event.event === "started");
    if (started) return started.pid;
    await sleep(TONE_LOG_POLL_MS);
  }
  throw new Error(`SpikeTone did not start (${path.basename(log)})`);
}

/** The capture window of a helper run, from its own "started" line to its last line. */
function captureWindow(lines, endT) {
  const started = lines.find((line) => line.event === "started");
  if (!started) throw new Error("capture has no started line");
  return { startT: started.t, endT: endT ?? Math.max(...lines.filter((line) => line.t).map((line) => line.t)) };
}

/**
 * A tone is evidence only if it was audible during the capture: `cover` (static runs)
 * needs it across the whole window; `late` (late launches) needs the tone to START strictly
 * inside the window, so the launch really happened mid-capture. Starting before the window ends is not enough: a
 * short tone can finish before a slow capture starts (Codex review of PR 71).
 */
function requireAudible(label, tone, window, mode) {
  const ok = mode === "cover"
    ? tone.startT <= window.startT && tone.stopT >= window.endT
    : tone.startT > window.startT && tone.startT < window.endT;
  if (!ok) {
    throw new Error(`${label}: tone [${tone.startT}, ${tone.stopT}] does not ${mode} capture [${window.startT}, ${window.endT}]`);
  }
  return tone;
}

/**
 * A SECOND instance of an already-running denylisted app starts audio after the tap exists:
 * the hole that remains with bundle IDs (the ID is already bound to the first). Instance 1
 * plays for the whole probe, so it is alive (and bound) when the tap is made and when
 * instance 2 starts; zero leak before instance 2 proves instance 1 is excluded (Codex review
 * of PR 71: an instance 1 that had already exited would turn this into the passing
 * single-late-launch case). `extra` is passed to the tap, e.g. the PR 3a rebuild flags.
 */
async function secondInstance(by, extra = [], { control = false, secondAtMs = LATE_LAUNCH_MS / 2 } = {}) {
  const firstSeconds = AUDIO_SECONDS * 3;
  const firstLog = launchTone("play", firstSeconds, "tap-first-instance");
  const firstPid = await waitForToneStart(firstLog);
  const objects = helper("procwatch", "--seconds", PROC_PHASE_SECONDS / 3, "--poll-ms", PROC_POLL_MS);
  if (!objects.some((line) => line.pid === firstPid && line.output)) {
    throw new Error(`instance 1 (pid ${firstPid}) has no CoreAudio process object playing before the tap`);
  }
  const late = background(["tap", "--seconds", AUDIO_SECONDS, "--exclude", TONE_BUNDLE_ID, ...by, ...extra]);
  await captureLive(late);
  await sleep(secondAtMs);
  const log = launchTone("play", AUDIO_SECONDS, "tap-second-instance");
  // The control: a tone the tap must NOT exclude, starting after any rebuild would be done.
  let bgLog = null;
  if (control) {
    await sleep(CONTROL_DELAY_MS);
    bgLog = bareTone(CONTROL_SECONDS, "tap-background-control", CONTROL_HZ);
  }
  const lines = await late.done;
  const window = captureWindow(lines);
  const tone = requireAudible("second-instance", await spikeToneInterval(log, AUDIO_SECONDS), window, "late");
  const first = requireAudible("first-instance", await spikeToneInterval(firstLog, firstSeconds), window, "cover");
  if (first.pid === tone.pid) throw new Error("both instances report the same pid");
  const loud = lines.filter((line) => line.windowRms > LEAK_RMS);
  let controlTone = null;
  let leaked = loud;
  if (bgLog) {
    const heardTone = requireAudible("background-control", await spikeToneInterval(bgLog, CONTROL_SECONDS), window, "late");
    // A window is stamped when it completes, so it covers (t - WINDOW_MS, t]. Windows that
    // overlap the control tone are the control; every other loud window, before OR after
    // it, is a leak (Codex review of PR 3a: counting only before the control hid late leaks).
    const overlapsControl = (line) => line.t > heardTone.startT && line.t - WINDOW_MS < heardTone.stopT;
    leaked = loud.filter((line) => !overlapsControl(line));
    const heard = loud.filter(overlapsControl).length;
    if (heard === 0) throw new Error("the tap captured nothing of the background control: it stopped capturing");
    controlTone = { ...heardTone, capturedWindows100ms: heard };
  }
  return { firstInstance: first, tone, controlTone, tapArgs: [...by, ...extra],
    leakedBeforeSecondStart: loud.filter((line) => line.t < tone.startT).length,
    leakedWindows100ms: leaked.length,
    // Each leaked window relative to the tones, so a leak can be attributed, not guessed at.
    leakedDetail: leaked.map((line) => ({ rms: line.windowRms, msAfterSecondStart: Math.round(line.t - tone.startT),
      msAfterControlStop: controlTone ? Math.round(line.t - controlTone.stopT) : null })),
    windows100ms: lines.filter((line) => line.windowRms !== undefined).length,
    rebuilds: lines.filter((line) => line.event === "tapRebuilt"),
    tailDrops: lines.filter((line) => line.event === "tailDropped"),
    // Did a drop discard audible audio? The direct evidence that the check stopped a leak.
    droppedLoud: lines.some((line) => (line.event === "tailDropped" || line.event === "tapRebuilt") && line.droppedMaxRms > LEAK_RMS),
    summary: lines.find((line) => line.event === "summary") };
}

const commands = {
  /** Build the helper, and wrap spike-tone in an ad-hoc-signed .app with its own bundle ID. */
  build() {
    run("swift", ["build", "-c", "release", "--package-path", PACKAGE_DIR], { stdio: ["ignore", "pipe", "inherit"] });
    const macos = path.join(TONE_APP, "Contents", "MacOS");
    fs.rmSync(TONE_APP, { recursive: true, force: true });
    fs.mkdirSync(macos, { recursive: true });
    fs.copyFileSync(path.join(RELEASE_DIR, "spike-tone"), path.join(macos, "spike-tone"));
    fs.writeFileSync(path.join(TONE_APP, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${TONE_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>SpikeTone</string>
  <key>CFBundleExecutable</key><string>spike-tone</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Geekspace spike: holds the mic open to test detection.</string>
</dict></plist>
`);
    run("codesign", ["--force", "--sign", "-", TONE_APP]);
    save("build", { helper: HELPER, toneApp: TONE_APP, outDir: OUT_DIR });
  },

  /**
   * PR 3b-1 proof: `gs-capture run` blanks the menu bar while a denylisted app owns it.
   * TextEdit (frontmost, showing the canary) is denylisted in one run and not in the control.
   * Each kept frame's menu-bar band is OCR'd: it must read nothing with the denylist, and
   * TextEdit's menus without it (the control proves the band check can see them at all).
   */
  async "run-menubar"() {
    const doc = path.join(OUT_DIR, `${CANARY}.txt`);
    fs.writeFileSync(doc, `SYNTHETIC test document for the Day Recorder spike.\n\n${CANARY}\n${CANARY}\n${CANARY}\n`);
    const result = {};
    try {
      for (const [tag, denylist] of [["denylisted", TEXTEDIT_BUNDLE_ID], ["control", ""]]) {
        run("open", ["-a", "TextEdit", doc]);
        await sleep(WINDOW_SETTLE_MS);
        const root = fs.mkdtempSync(path.join(OUT_DIR, `run-${tag}-`));
        const lines = helper("run", "--media-root", root, "--denylist", denylist, "--shot-sec", RUN_SHOT_SEC, "--duration", RUN_SECONDS);
        const shots = lines.filter((line) => line.event === "shot");
        if (!shots.length) throw new Error(`${tag}: run kept no frames`);
        result[tag] = shots.map((shot) => {
          // The helper's own crop (Screen.crop): `sips --cropOffset` did not crop where asked.
          const [band] = helper("ocr", "--level", "merged", "--text", "1", "--crop", `0,0,${DISPLAY_WIDTH_PT},${MENU_BAR_PT}`,
            path.join(root, shot.path));
          return { menuBarBlanked: shot.menuBarBlanked, appBundleId: shot.appBundleId,
            bandMeanLuma: band.meanLuma, bandLines: band.lines,
            bandHasFormatMenu: band.text.some((t) => /\bFormat\b/.test(t)), frameHasCanary: shot.ocrText.includes(CANARY) };
        });
      }
    } finally {
      spawnSync("osascript", ["-e", `tell application "TextEdit" to close (every document whose name contains "${CANARY}") saving no`], { encoding: "utf8" });
    }
    const denied = result.denylisted;
    const control = result.control;
    save("pr3b1-run-menubar", result);
    // The control must show the band carrying content and TextEdit on screen, or the
    // denylisted run's black band and missing canary prove nothing. Menu TEXT can only be
    // asserted where the menu bar is drawn; with "hide the menu bar" on it never is.
    if (!control.every((s) => s.bandMeanLuma > BAND_CONTENT_LUMA && s.frameHasCanary)) {
      throw new Error("control: the band carried no content or TextEdit was not on screen; the check proves nothing");
    }
    // With any app denylisted, EVERY frame's menu bar is blanked (Codex review of PR 3b-1,
    // round 2: a switch during a capture can't be observed). So every frame's band must be
    // black and unread, no frame names TextEdit, and the canary never appears.
    const leaks = denied.filter((s) => !s.menuBarBlanked || s.bandMeanLuma > BAND_BLACK_LUMA || s.bandLines > 0
      || s.appBundleId === TEXTEDIT_BUNDLE_ID || s.frameHasCanary);
    if (leaks.length) throw new Error(`denylisted: ${leaks.length} frame(s) kept menu-bar text, the canary or TextEdit's id`);
  },

  /** Q1: does excluding TextEdit's bundle ID remove its window from the frame? */
  async exclusion() {
    const doc = path.join(OUT_DIR, `${CANARY}.txt`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(doc, `SYNTHETIC test document for the Day Recorder spike.\n\n${CANARY}\n${CANARY}\n${CANARY}\n`);
    run("open", ["-a", "TextEdit", doc]);
    await sleep(WINDOW_SETTLE_MS);
    const results = {};
    for (const [scene, front] of [["textedit-front", null], ["textedit-background", FINDER_BUNDLE_ID]]) {
      if (front) {
        run("open", ["-b", front]);
        await sleep(WINDOW_SETTLE_MS);
      }
      const [win] = helper("windows", "--bundle", TEXTEDIT_BUNDLE_ID, "--title-contains", CANARY);
      if (!win) throw new Error(`no on-screen TextEdit window titled ${CANARY}`);
      const sceneResult = { frontmost: front ?? TEXTEDIT_BUNDLE_ID, window: { x: win.x, y: win.y, w: win.w, h: win.h } };
      for (const [label, exclude] of [["control", ""], ["excluded", TEXTEDIT_BUNDLE_ID]]) {
        // The real, unrestricted frame: scored by OCR in memory, never kept as evidence.
        const full = path.join(OUT_DIR, `q1-${scene}-${label}-full.png`);
        const [shot] = helper("shot", "--out", full, "--exclude", exclude);
        const [ocrFull] = helper("ocr", "--text", "1", full);
        fs.rmSync(full);
        const canaryLines = ocrFull.text.filter((line) => line.includes(CANARY)).length;
        sceneResult[label] = { excludedApps: shot.excludedApps, captureMs: shot.captureMs, canaryLinesInFrame: canaryLines };
      }
      results[scene] = sceneResult;
    }
    // Evidence images: the same exclusion, over a synthetic backdrop, with every other app
    // also left out (--keep-only) so no real window can appear in a committed screenshot.
    const [win] = helper("windows", "--bundle", TEXTEDIT_BUNDLE_ID, "--title-contains", CANARY);
    const pad = BACKDROP_PAD_PT;
    const stage = [win.x - pad, win.y - pad, win.w + pad * 2, win.h + pad * 2].map(Math.round);
    launchTone("backdrop", BACKDROP_SECONDS, "q1-backdrop", stage);
    await sleep(WINDOW_SETTLE_MS);
    run("open", ["-a", "TextEdit", doc]);
    await sleep(WINDOW_SETTLE_MS);
    // --keep-only works per app, not per window: ANY other window of a kept app, on any
    // layer (documents, panels, sheets), inside the crop would land in a committed image.
    // Only the canary document and the backdrop may be there (Codex review of PR 72).
    const [sx, sy, sw, sh] = stage;
    const kept = helper("windows", "--bundle", `${TEXTEDIT_BUNDLE_ID},${TONE_BUNDLE_ID}`, "--layers", "all");
    const backdrop = kept.filter((w) => w.bundle === TONE_BUNDLE_ID && w.layer === 0);
    if (backdrop.length !== 1) throw new Error(`expected exactly one backdrop window, found ${backdrop.length}`);
    const allowed = new Set([win.windowID, backdrop[0].windowID]);
    const intruders = kept.filter((w) => !allowed.has(w.windowID) && w.x < sx + sw && w.x + w.w > sx && w.y < sy + sh && w.y + w.h > sy);
    if (intruders.length) {
      throw new Error(`${intruders.length} other window(s) of a kept app overlap the evidence crop; close or move them and re-run`);
    }
    results.stage = { rect: stage };
    for (const [label, exclude] of [["control", ""], ["excluded", TEXTEDIT_BUNDLE_ID]]) {
      const out = path.join(OUT_DIR, `q1-stage-${label}.png`);
      const [shot] = helper("shot", "--out", out, "--exclude", exclude, "--keep-only", `${TONE_BUNDLE_ID},${TEXTEDIT_BUNDLE_ID}`,
        "--crop", stage.join(","));
      const [ocr] = helper("ocr", "--text", "1", out);
      results.stage[label] = { out, canaryLines: ocr.text.filter((line) => line.includes(CANARY)).length,
        backdropSeen: ocr.text.some((line) => line.includes("SYNTHETIC BACKDROP")), excludedApps: shot.excludedApps };
    }
    // Close only the synthetic document. Needs Automation permission for TextEdit; if that
    // is refused the window just stays open, so say so instead of failing the measurement.
    const close = spawnSync("osascript", ["-e", `tell application "TextEdit" to close (every document whose name contains "${CANARY}") saving no`], { encoding: "utf8" });
    if (close.status !== 0) console.error(`warning: could not close the canary document: ${close.stderr.trim()}`);
    save("q1-exclusion", results);
  },

  /** Q2: does an SCK audio stream that excludes the tone app's bundle ID hear it? */
  async audio() {
    const capture = (exclude, tag) => {
      const lines = helper("audio", "--seconds", AUDIO_SECONDS, "--exclude", exclude, "--out", path.join(OUT_DIR, `q2-${tag}.wav`));
      return { summary: lines.find((line) => line.event === "summary"), window: captureWindow(lines, Date.now()) };
    };
    const result = { silenceBaseline: capture("", "silence").summary };
    for (const [tag, exclude, mode] of [["control", "", "play"], ["excluded", TONE_BUNDLE_ID, "play"],
      ["excluded-windowless", TONE_BUNDLE_ID, "play-windowless"]]) {
      const log = launchTone(mode, TONE_SECONDS, `q2-${tag}`);
      await sleep(TONE_WARMUP_MS);
      const { summary, window } = capture(exclude, tag);
      const tone = requireAudible(tag, await spikeToneInterval(log, TONE_SECONDS), window, "cover");
      result[tag] = { ...summary, tone, window };
    }
    // The filter holds SCRunningApplication instances: an app launched AFTER the stream
    // starts is not in it. Measure the leak with a static filter, then with a re-listing one.
    for (const [tag, follow] of [["lateLaunchStatic", []], ["lateLaunchFollow", ["--follow-ms", FOLLOW_MS]]]) {
      const late = background(["audio", "--seconds", AUDIO_SECONDS * 2, "--exclude", TONE_BUNDLE_ID, ...follow]);
      await captureLive(late);
      await sleep(LATE_LAUNCH_MS);
      const lateLog = launchTone("play", TONE_SECONDS, `q2-${tag}`);
      const lines = await late.done;
      const tone = requireAudible(tag, await spikeToneInterval(lateLog, TONE_SECONDS), captureWindow(lines), "late");
      const started = { t: tone.startT };
      const loud = lines.filter((line) => line.windowRms > LEAK_RMS);
      result[tag] = {
        summary: lines.find((line) => line.event === "summary"),
        filterUpdates: lines.filter((line) => line.event === "filterUpdated"),
        toneStartedT: started?.t ?? null,
        leakedWindows100ms: loud.length,
        leakFirstT: loud[0]?.t ?? null,
        leakLastT: loud.at(-1)?.t ?? null,
        leakMsAfterToneStart: loud.length && started ? round(loud.at(-1).t - started.t) : 0,
      };
    }
    save("q2-audio", result);
  },

  /**
   * Q2/Q4 extension: Chromium plays audio from a helper process. Does excluding the APP
   * (com.github.Electron, standing in for any browser) drop that audio, and does CoreAudio
   * attribute the helper's output and mic use back to the app?
   */
  async "web-audio"() {
    const { interval } = electronTone(WEB_TONE_SECONDS);
    const watch = background(["procwatch", "--seconds", WEB_TONE_SECONDS, "--poll-ms", PROC_POLL_MS]);
    await sleep(TONE_WARMUP_MS * 2);
    const capture = (exclude) => {
      const lines = helper("audio", "--seconds", AUDIO_SECONDS / 2, "--exclude", exclude);
      return { summary: lines.find((line) => line.event === "summary"), window: captureWindow(lines, Date.now()) };
    };
    const control = capture("");
    const excluded = capture(ELECTRON_BUNDLE_ID);
    const procLines = (await watch.done).filter((line) => "bundle" in line && line.bundle !== "com.apple.avconferenced");
    const tone = await interval;
    requireAudible("web-audio control", tone, control.window, "cover");
    requireAudible("web-audio excluded", tone, excluded.window, "cover");
    save("q2-web-audio", {
      app: ELECTRON_BUNDLE_ID, tone,
      control: { dbfs: control.summary.dbfs, excludedApps: control.summary.excludedApps, window: control.window },
      excluded: { dbfs: excluded.summary.dbfs, peak: excluded.summary.peak, excludedApps: excluded.summary.excludedApps, window: excluded.window },
      coreAudio: procLines.map(({ t, reason, bundle, pid, responsibleBundle, input, output }) => ({ t, reason, bundle, pid, responsibleBundle, input, output })),
    });
  },

  /**
   * Re-plan check (James, 2026-10-18): system audio through a CoreAudio process tap that
   * excludes every process of a denylisted app, helpers included. Same scenarios as Q2,
   * plus the Chromium helper case SCK failed.
   */
  /**
   * PR 3b-2 proof: `gs-capture run` writes system audio as segments, and:
   * - every segment converts alone through the transcriber's ffmpeg call (meetingProcessor.mjs);
   * - the denylisted app (SpikeTone, 440 Hz) never reaches a segment, including a second
   *   instance that starts mid-run and forces a tap rebuild;
   * - a non-denylisted tone (bare spike-tone, 660 Hz) does: the positive control;
   * - SIGTERM finalizes the open segment and leaves no partial file.
   */
  async "run-segments"() {
    const root = fs.mkdtempSync(path.join(OUT_DIR, "run-segments-"));
    const runSeconds = RUN_SEG_STOP_MS / 1000;
    const firstLog = launchTone("play", runSeconds + 4, "run-seg-first");
    await waitForToneStart(firstLog);
    // GS_RUN_DENYLIST="" is the negative control: nothing excluded, so the gate must report
    // the 440 Hz tone as leaked. Without it a passing run could mean a blind detector.
    const denylist = process.env.GS_RUN_DENYLIST ?? TONE_BUNDLE_ID;
    const handle = background(["run", "--media-root", root, "--denylist", denylist,
      "--shot-sec", RUN_SEG_SHOT_SEC, "--segment-sec", RUN_SEGMENT_SEC]);
    await captureLive(handle);
    const readyAt = Date.now();
    await sleep(RUN_SEG_SECOND_MS);
    const secondLog = launchTone("play", 3, "run-seg-second");
    await sleep(RUN_SEG_CONTROL_MS - RUN_SEG_SECOND_MS);
    const controlLog = bareTone(CONTROL_SECONDS * 2, "run-seg-control", CONTROL_HZ);
    await sleep(RUN_SEG_STOP_MS - (Date.now() - readyAt));
    handle.child.kill("SIGTERM");
    const lines = await handle.done;
    const first = await spikeToneInterval(firstLog, runSeconds + 4);
    const second = await spikeToneInterval(secondLog, 3);
    const control = await spikeToneInterval(controlLog, CONTROL_SECONDS * 2);

    const stopped = lines.at(-1);
    if (stopped?.event !== "stopped" || stopped.reason !== "signal") throw new Error(`last line is not stopped/signal: ${JSON.stringify(stopped)}`);
    if (lines.some((line) => line.v !== 1)) throw new Error("a line without v: 1");
    const segments = lines.filter((line) => line.event === "segment");
    if (segments.length < 2) throw new Error(`only ${segments.length} segment(s) for a ${runSeconds} s run`);
    const leftovers = fs.readdirSync(root, { recursive: true }).filter((name) => path.basename(String(name)).startsWith(".partial-"));
    const decoded = segments.map((segment, index) => {
      const file = path.join(root, segment.path);
      // The transcriber's exact conversion, on this segment alone.
      const wav = path.join(OUT_DIR, `run-seg-${index}.wav`);
      run("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
      const raw = run("ffmpeg", ["-loglevel", "error", "-i", wav, "-f", "f32le", "-ac", "1", "-ar", String(SPEECH_SAMPLE_RATE), "-"],
        { encoding: "buffer" });
      const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      const denied = toneAmplitudes(samples, TONE_HZ);
      const heard = toneAmplitudes(samples, CONTROL_HZ);
      const [refLow, refHigh] = REFERENCE_HZ.map((hz) => toneAmplitudes(samples, hz));
      const floor = (i) => Math.max(refLow[i], refHigh[i]);
      // Window i covers [start + i*100, start + (i+1)*100) ms of wall clock.
      const at = (i) => segment.start + i * WINDOW_MS;
      return {
        path: segment.path, start: segment.start, end: segment.end, bytes: fs.statSync(file).size,
        decodedMs: round((samples.length / SPEECH_SAMPLE_RATE) * 1000), spanMs: round(segment.end - segment.start),
        ...Object.fromEntries(["leaked", "broadband"].map((kind) => [kind, denied
          .map((amp, i) => ({ msFromStart: i * WINDOW_MS, at: at(i), amp: round(amp, 4), floor: round(floor(i), 4),
            tonal: amp > TONAL_RATIO * floor(i) }))
          .filter((w) => w.amp > LEAK_RMS && w.tonal === (kind === "leaked"))])),
        controlWindows: heard.filter((amp, i) => amp > LEAK_RMS && at(i) > control.startT && at(i) < control.stopT).length,
      };
    });
    const result = {
      tones: { first, second, control }, segments: decoded, partialLeftovers: leftovers,
      rebuilds: lines.filter((line) => line.event === "tapRebuilt"), tailDrops: lines.filter((line) => line.event === "tailDropped"),
      leakedWindows100ms: decoded.reduce((sum, d) => sum + d.leaked.length, 0),
      controlWindows100ms: decoded.reduce((sum, d) => sum + d.controlWindows, 0),
      stopped,
    };
    save(denylist ? "pr3b2-run-segments" : "pr3b2-run-segments-control", result);
    if (leftovers.length) throw new Error(`partial files left behind: ${leftovers.join(", ")}`);
    // Only a denylisted run expects a rebuild. The negative control (nothing denylisted) must
    // reach the leak check below and fail THERE, so its exit code proves the detector
    // (Codex review of PR 3b-2, round 6).
    if (denylist && !result.rebuilds.length) throw new Error("instance 2 did not force a tap rebuild; the scenario proves nothing");
    if (result.controlWindows100ms === 0) throw new Error("the control tone reached no segment: capture is not working");
    if (result.leakedWindows100ms) throw new Error(`${result.leakedWindows100ms} window(s) carried the denylisted tone`);
  },

  /**
   * PR 3b-2 proof (Codex P1): a second denylisted instance that starts, plays and EXITS
   * between two polls. A poll compares only live processes, so it never sees it; the
   * arrivals listener must. GS_TAP_LISTEN=0 is the control (listener off): it must leak.
   * A non-denylisted tone after the rebuild shows the tap still captures.
   *
   * GS_TRANSIENT=slow-classifier is the round-5 race (classification still in flight when
   * audio would be released): polls every 700 ms, a 1.5 s hold, a 0.1 s tone, and every
   * classification slowed to 2.2 s (longer than the hold, under the 5 s stall limit).
   * GS_TAP_EXTRA="--release-cap 0" is its control: release by the clock must leak.
   *
   * GS_TRANSIENT=b-during-a (PR #78 round 1): the same timing, plus process A, an ALLOWED
   * silent tone (SpikeTone at 0 Hz, no bundle ID) whose slow judgement starts first. Instance
   * 2 (B) must start and exit while A is still being judged. With one queue for snapshots and
   * judgements, B is never observed. Its control is the previous binary (GS_CAPTURE_BIN).
   */
  async "tap-transient-instance"() {
    const listen = process.env.GS_TAP_LISTEN !== "0";
    const bDuringA = process.env.GS_TRANSIENT === "b-during-a";
    const slow = process.env.GS_TRANSIENT === "slow-classifier" || bDuringA;
    const pollMs = slow ? SLOW_CLASSIFIER.pollMs : TRANSIENT_POLL_MS;
    const holdMs = slow ? SLOW_CLASSIFIER.holdMs : TRANSIENT_HOLD_MS;
    const playSeconds = slow ? SLOW_CLASSIFIER.playSeconds : TRANSIENT_PLAY_SECONDS;
    const extra = [...(slow ? ["--classify-delay-ms", SLOW_CLASSIFIER.classifyDelayMs] : []),
      ...(process.env.GS_TAP_EXTRA ?? "").split(/\s+/).filter(Boolean)];
    const capped = !extra.includes("--release-cap");
    const firstSeconds = TRANSIENT_TAP_SECONDS + 4;
    const firstLog = launchTone("play", firstSeconds, "transient-first");
    await waitForToneStart(firstLog);
    const tap = background(["tap", "--seconds", TRANSIENT_TAP_SECONDS, "--exclude", TONE_BUNDLE_ID, "--by", "both",
      "--rebuild-ms", pollMs, "--hold-ms", holdMs, ...(listen ? [] : ["--listen", "0"]), ...extra]);
    await captureLive(tap);
    const liveAt = Date.now();
    let silentA = null;
    if (bDuringA) {
      // 0 Hz: a real output stream of zeros, so A is an audio process the tap's RMS meter
      // can't mistake for a leak.
      const aLog = bareTone(B_DURING_A.aSeconds, "transient-a", 0);
      silentA = { log: aLog, startT: null };
      const deadline = Date.now() + TONE_LOG_GRACE_MS;
      while (!readTone(aLog).some((event) => event.event === "started")) {
        if (Date.now() > deadline) throw new Error("silent process A did not start");
        await sleep(TONE_LOG_POLL_MS / 4);
      }
      silentA.startT = readTone(aLog).find((event) => event.event === "started").t;
      await sleep(B_DURING_A.bAfterAMs);
    } else {
      await sleep(TRANSIENT_START_MS);
    }
    // Linger 0: the process exits as soon as its tone stops.
    const secondLog = launchTone("play", playSeconds, "transient-second", [TONE_HZ, 0]);
    await sleep(TRANSIENT_CONTROL_MS - (Date.now() - liveAt));
    const controlLog = bareTone(CONTROL_SECONDS, "transient-control", CONTROL_HZ);
    const lines = await tap.done;
    const window = captureWindow(lines);
    const second = requireAudible("transient-second", await spikeToneInterval(secondLog, playSeconds), window, "late");
    const first = requireAudible("transient-first", await spikeToneInterval(firstLog, firstSeconds), window, "cover");
    const heardTone = requireAudible("transient-control", await spikeToneInterval(controlLog, CONTROL_SECONDS), window, "late");
    if (first.pid === second.pid) throw new Error("both instances report the same pid");
    // The scenario is only meaningful if instance 2's PROCESS was gone before the first
    // scheduled poll after it started (its audio stopping is not enough: the first attempt
    // used the tone's default 2 s linger, and the poll caught the still-live object). Polls
    // run at the tap's start and every TRANSIENT_POLL_MS after.
    const exiting = readTone(secondLog).find((event) => event.event === "exiting");
    // B must live entirely inside A's judgement (A's start plus the judge delay).
    if (silentA && exiting && exiting.t >= silentA.startT + SLOW_CLASSIFIER.classifyDelayMs) {
      throw new Error(`B exited ${Math.round(exiting.t - silentA.startT)} ms after A started, outside A's judgement`);
    }
    if (!exiting) throw new Error("instance 2 did not log its exit");
    if (pidAlive(second.pid)) throw new Error(`instance 2 (pid ${second.pid}) is still running`);
    // Judged on what the run LOGGED, not a computed poll schedule (Codex review of PR #78,
    // round 2: polls are rescheduled from each tick, and a listener check resets them). A
    // scheduled poll that saw instance 2 rebuilt with trigger "poll" naming its bundle; such
    // a run proves nothing about the listener and is rejected.
    // `pollDue` and `addedBundles` are recorded by the helper at the check itself, so a check
    // that was both listener-forced and a due poll still counts as the poll seeing it.
    const polledSecond = lines.filter((line) => line.event === "tapRebuilt" && line.pollDue
      && (line.addedBundles ?? []).includes(TONE_BUNDLE_ID));
    if (polledSecond.length) throw new Error(`a scheduled poll saw instance 2 (${polledSecond.length} poll rebuild(s)); run rejected`);
    const loud = lines.filter((line) => line.windowRms > LEAK_RMS);
    const overlapsControl = (line) => line.t > heardTone.startT && line.t - WINDOW_MS < heardTone.stopT;
    const inControlTail = (line) => !overlapsControl(line) && line.t > heardTone.stopT && line.t <= heardTone.stopT + CONTROL_TAIL_MS;
    const leaked = loud.filter((line) => !overlapsControl(line) && !inControlTail(line));
    const result = {
      listen, capped, pollMs, holdMs, tapExtra: extra, first, second, controlTone: { ...heardTone, capturedWindows100ms: loud.filter(overlapsControl).length },
      controlTail: loud.filter(inControlTail).map((line) => ({ rms: line.windowRms, msAfterControlStop: Math.round(line.t - heardTone.stopT) })),
      secondLivedMs: Math.round(exiting.t - second.startT), pollRebuildsSeeingSecond: polledSecond.length,
      leakedWindows100ms: leaked.length,
      leakedDetail: leaked.map((line) => ({ rms: line.windowRms, msAfterSecondStart: Math.round(line.t - second.startT) })),
      rebuilds: lines.filter((line) => line.event === "tapRebuilt"), tailDrops: lines.filter((line) => line.event === "tailDropped"),
      summary: lines.find((line) => line.event === "summary"),
    };
    if (silentA) result.silentA = { startT: silentA.startT, bExitedMsAfterAStart: Math.round(exiting.t - silentA.startT) };
    const label = `${bDuringA ? "b-during-a-" : slow ? "slow-" : ""}${listen ? "listener" : "control"}${capped ? "" : "-uncapped"}`;
    save(`pr3b2-transient-instance-${label}`, result);
    if (result.controlTone.capturedWindows100ms === 0) throw new Error("the tap captured nothing of the control: it stopped capturing");
    const protectedRun = listen && capped;
    if (protectedRun && result.leakedWindows100ms) throw new Error(`${result.leakedWindows100ms} window(s) of instance 2 leaked`);
    if (!protectedRun && !result.leakedWindows100ms) throw new Error("control: no leak without the protection, so the scenario proves nothing");
  },

  /**
   * PR #78 proof (Codex round 2): a helper whose denylisted parent exits while it keeps
   * playing. SpikeTone (denylisted) spawns a bare child tone (no bundle ID), waits until it
   * plays, and exits. The child is observed while its parent lives and judged after the
   * parent is gone (judgement slowed to 2.2 s), so it is `unreadable`. It must stay excluded
   * for the rest of its life even though a re-poll can no longer tie it to the denylist.
   * A non-denylisted control tone plays after the child stops. The control for the fix is
   * the previous binary (GS_CAPTURE_BIN).
   *
   * GS_ORPHAN=baseline (Codex review of PR #78, round 3): the child is already playing when
   * the tap starts, under a parent that lives 3 s, so the INITIAL poll excludes it and the
   * listener never judges it. After the parent exits, a short unrelated denylisted instance
   * forces a rebuild. Normal judgement speed.
   */
  async "tap-orphan-helper"() {
    const baseline = process.env.GS_ORPHAN === "baseline";
    const childPath = path.join(RELEASE_DIR, "spike-tone");
    let log = null;
    let liveAt = null;
    if (baseline) {
      log = launchTone("spawn-child", ORPHAN.childSeconds, "orphan", [TONE_HZ, childPath, ORPHAN.baselineParentSeconds]);
      await sleep(ORPHAN.startMs);
    }
    const tap = background(["tap", "--seconds", ORPHAN.tapSeconds, "--exclude", TONE_BUNDLE_ID, "--by", "both",
      "--rebuild-ms", SLOW_CLASSIFIER.pollMs, "--hold-ms", SLOW_CLASSIFIER.holdMs,
      ...(baseline ? [] : ["--classify-delay-ms", SLOW_CLASSIFIER.classifyDelayMs])]);
    await captureLive(tap);
    liveAt = Date.now();
    let triggerLog = null;
    if (baseline) {
      await sleep(ORPHAN.triggerMs);
      triggerLog = launchTone("play", 0.2, "orphan-trigger", [TONE_HZ, 0]);
    } else {
      await sleep(ORPHAN.startMs);
      log = launchTone("spawn-child", ORPHAN.childSeconds, "orphan", [TONE_HZ, childPath]);
    }
    await sleep(ORPHAN.controlMs - (Date.now() - liveAt));
    const controlLog = bareTone(CONTROL_SECONDS, "orphan-control", CONTROL_HZ);
    const lines = await tap.done;
    const window = captureWindow(lines);
    const events = readTone(log);
    const spawned = events.find((event) => event.event === "spawned");
    if (!spawned) throw new Error("SpikeTone did not spawn its child");
    const parentExit = events.find((event) => event.event === "exiting" && event.pid === spawned.pid);
    const childStart = events.find((event) => event.event === "started" && event.pid === spawned.childPid);
    // SpikeTone's "stopped" line carries no pid; the child is the only "play" process here.
    const childStop = events.find((event) => event.event === "stopped" && event.mode === "play");
    if (!parentExit || !childStart || !childStop) throw new Error("orphan scenario did not log parent exit and child start/stop");
    // The scenario's preconditions, from what was logged: the child played while its parent
    // lived, outlived it, and played inside the capture.
    if (!(childStart.t < parentExit.t)) throw new Error("the child started playing only after its parent exited");
    if (!(childStop.t > parentExit.t + ORPHAN.minOrphanMs)) throw new Error("the child barely outlived its parent");
    if (baseline) {
      if (!(childStart.t < window.startT && parentExit.t > window.startT)) {
        throw new Error("baseline: the child must already play, and its parent still live, when the tap starts");
      }
    } else if (!(childStart.t > window.startT)) {
      throw new Error("the child did not start inside the capture");
    }
    if (!(childStop.t < window.endT)) throw new Error("the child did not stop inside the capture");
    // The rebuild this proof exists for must have happened, after the parent exited and while
    // the child still played, and must still exclude the child (Codex review of PR #78,
    // round 3). Without it a zero-leak run proves nothing about persistent exclusion.
    const rebuilds = lines.filter((line) => line.event === "tapRebuilt");
    const decisive = rebuilds.filter((line) => line.t > parentExit.t && line.t < childStop.t
      && (baseline || (line.trigger === "listener" && (line.arrivedBundles ?? []).includes("unclassified"))));
    if (!decisive.length) throw new Error("no rebuild after the parent exited and before the child stopped: nothing was tested");
    const childExcludedThrough = decisive.every((line) => (line.excludedPids ?? []).includes(spawned.childPid));
    const heardTone = requireAudible("orphan-control", await spikeToneInterval(controlLog, CONTROL_SECONDS), window, "late");
    if (heardTone.startT < childStop.t) throw new Error("the control overlapped the child");
    const loud = lines.filter((line) => line.windowRms > LEAK_RMS);
    const overlapsControl = (line) => line.t > heardTone.startT && line.t - WINDOW_MS < heardTone.stopT;
    const inControlTail = (line) => !overlapsControl(line) && line.t > heardTone.stopT && line.t <= heardTone.stopT + CONTROL_TAIL_MS;
    const leaked = loud.filter((line) => !overlapsControl(line) && !inControlTail(line));
    const result = {
      variant: baseline ? "baseline" : "arrival", spawned, parentExit, childStart, childStop,
      orphanedMs: Math.round(childStop.t - parentExit.t), decisiveRebuilds: decisive.length, childExcludedThrough,
      trigger: triggerLog ? readTone(triggerLog).find((event) => event.event === "started") ?? null : null,
      controlTone: { ...heardTone, capturedWindows100ms: loud.filter(overlapsControl).length },
      leakedWindows100ms: leaked.length,
      leakedDetail: leaked.map((line) => ({ rms: line.windowRms, msAfterParentExit: Math.round(line.t - parentExit.t) })),
      rebuilds: lines.filter((line) => line.event === "tapRebuilt"), tailDrops: lines.filter((line) => line.event === "tailDropped"),
      helper: process.env.GS_CAPTURE_BIN ?? "this build",
    };
    save(`pr78-orphan-helper-${baseline ? "baseline-" : ""}${process.env.GS_CAPTURE_BIN ? "previous-binary" : "fixed"}`, result);
    if (result.controlTone.capturedWindows100ms === 0) throw new Error("the tap captured nothing of the control: it stopped capturing");
    if (!process.env.GS_CAPTURE_BIN && result.leakedWindows100ms) throw new Error(`${result.leakedWindows100ms} window(s) of the orphaned helper leaked`);
    if (!process.env.GS_CAPTURE_BIN && !childExcludedThrough) throw new Error("a decisive rebuild did not exclude the child");
    if (process.env.GS_CAPTURE_BIN && !result.leakedWindows100ms) throw new Error("control: the previous binary did not leak, so the scenario proves nothing");
  },

  /**
   * PR 3a proof: only the second-instance scenario, bundle IDs plus live process objects.
   * GS_TAP_EXTRA adds tap flags ("--rebuild-ms 100 --hold-ms 500"); GS_SPIKE_LABEL names
   * the result file. Run once without flags as the positive control (the leak), once with.
   */
  async "tap-second-instance"() {
    const extra = (process.env.GS_TAP_EXTRA ?? "").split(/\s+/).filter(Boolean);
    const label = process.env.GS_SPIKE_LABEL ?? (extra.length ? "rebuild" : "control");
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error(`GS_SPIKE_LABEL must be [a-z0-9-], got ${label}`);
    // GS_SECOND_AT_MS launches instance 2 that long after capture starts. Near the deadline
    // (AUDIO_SECONDS) it tests the shutdown tail; there is then no room for the control.
    const secondAtMs = process.env.GS_SECOND_AT_MS ? Number(process.env.GS_SECOND_AT_MS) : undefined;
    if (secondAtMs !== undefined && !(secondAtMs > 0 && secondAtMs < AUDIO_SECONDS * 1000)) {
      throw new Error(`GS_SECOND_AT_MS must be inside the ${AUDIO_SECONDS} s capture, got ${process.env.GS_SECOND_AT_MS}`);
    }
    const control = secondAtMs === undefined;
    save(`pr3a-second-instance-${label}`, await secondInstance(["--by", "both"], extra, { control, secondAtMs }));
  },

  async tap() {
    // GS_TAP_BY=bundle|both (macOS 26+): bundle IDs, or bundle IDs plus live process
    // objects; default is process objects only.
    const mode = ["bundle", "both"].includes(process.env.GS_TAP_BY) ? process.env.GS_TAP_BY : null;
    const by = mode ? ["--by", mode] : [];
    const tap = (exclude, extra = []) => {
      const lines = helper("tap", "--seconds", AUDIO_SECONDS, "--exclude", exclude, ...by, ...extra);
      return { lines, window: captureWindow(lines, Date.now()) };
    };
    const summary = ({ lines }) => {
      const s = lines.find((line) => line.event === "summary");
      const started = lines.find((line) => line.event === "started");
      return { dbfs: s.dbfs, peak: s.peak, excludedProcesses: started.excludedProcesses, excludedBundles: started.excludedBundles };
    };
    const result = { silenceBaseline: summary(tap("")) };
    for (const [tag, exclude, mode] of [["tone-control", "", "play"], ["tone-excluded", TONE_BUNDLE_ID, "play"],
      ["tone-windowless-excluded", TONE_BUNDLE_ID, "play-windowless"]]) {
      const log = launchTone(mode, TONE_SECONDS, `tap-${tag}`);
      await sleep(TONE_WARMUP_MS);
      const run = tap(exclude);
      const tone = requireAudible(tag, await spikeToneInterval(log, TONE_SECONDS), run.window, "cover");
      result[tag] = { ...summary(run), tone, window: run.window };
    }
    for (const [tag, exclude] of [["electron-control", ""], ["electron-excluded", ELECTRON_BUNDLE_ID]]) {
      const { interval } = electronTone(WEB_TONE_SECONDS);
      await sleep(TONE_WARMUP_MS * 2);
      const run = tap(exclude);
      const tone = requireAudible(tag, await interval, run.window, "cover");
      result[tag] = { ...summary(run), tone, window: run.window };
    }
    // Late launch: the helper's process object does not exist until it first plays.
    // late-control excludes nothing: the positive control that the late tone was captured.
    for (const [tag, exclude, follow] of [["late-control", "", []], ["late-static", ELECTRON_BUNDLE_ID, []],
      ["late-follow", ELECTRON_BUNDLE_ID, ["--follow-ms", FOLLOW_MS]]]) {
      if (by.length && follow.length) continue;
      const late = background(["tap", "--seconds", AUDIO_SECONDS * 2, "--exclude", exclude, ...by, ...follow]);
      await captureLive(late);
      await sleep(LATE_LAUNCH_MS);
      const { interval } = electronTone(AUDIO_SECONDS);
      let lines;
      try {
        lines = await late.done;
      } catch (error) {
        // Expected for process-object mode: a live tap refuses exclusion updates ('!hog').
        await interval;
        result[tag] = { error: error.message };
        continue;
      }
      const tone = requireAudible(tag, await interval, captureWindow(lines), "late");
      const started = { t: tone.startT };
      const loud = lines.filter((line) => line.windowRms > LEAK_RMS);
      result[tag] = { updates: lines.filter((line) => line.event === "tapUpdated"), toneStartedT: started?.t ?? null,
        leakedWindows100ms: loud.length, leakFirstT: loud[0]?.t ?? null, leakLastT: loud.at(-1)?.t ?? null };
    }
    if (mode) result["late-second-instance"] = await secondInstance(by);
    save(mode ? `q2-tap-${mode}` : "q2-tap", result);
  },

  /** Q4 browser stand-in: which Chromium process holds the REAL mic, as CoreAudio sees it? */
  async "web-mic"() {
    const watch = background(["procwatch", "--seconds", WEB_TONE_SECONDS + PROC_PHASE_SECONDS * 2, "--poll-ms", PROC_POLL_MS]);
    await sleep(PROC_GAP_MS);
    const electron = spawn(path.join(ROOT, "node_modules", ".bin", "electron"), [path.join(ROOT, "scripts", "spike", "web-tone.cjs")], {
      env: { ...process.env, GS_TONE_SECONDS: String(WEB_TONE_SECONDS), GS_TONE_REAL_MIC: "1" }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    electron.stdout.on("data", (chunk) => { out += chunk; });
    const exited = new Promise((resolve, reject) => { electron.on("close", resolve); electron.on("error", reject); });
    const lines = await watch.done;
    const code = await exited;
    // A denied or failed getUserMedia exits 1 without "started": not a measurement.
    const started = jsonLines(out).find((event) => event.event === "started") ?? null;
    if (code !== 0 || !started) throw new Error(`web-mic probe failed (exit ${code}, started ${started ? "yes" : "no"}); nothing saved`);
    save("q4-web-mic", { started, electronMainPid: electron.pid,
      events: lines.filter((line) => /Electron/.test(line.bundle ?? "") || line.reason === "gone")
        .map(({ t, reason, bundle, pid, responsibleBundle, input, output }) => ({ t, reason, bundle, pid, responsibleBundle, input, output })) });
  },

  /** Q3: do CoreAudio process objects report the tone app's output and input, and how fast? */
  async procwatch() {
    // Listeners alone miss mic use on macOS 27.0 (see ProcWatch.swift), so poll as well.
    const watch = background(["procwatch", "--seconds", PROCWATCH_SECONDS, "--poll-ms", PROC_POLL_MS]);
    await sleep(PROC_GAP_MS);
    const playLog = launchTone("play", PROC_PHASE_SECONDS, "q3-play");
    await sleep(PROC_PHASE_SECONDS * 1000 + PROC_GAP_MS * 2);
    const listenLog = launchTone("listen", PROC_PHASE_SECONDS, "q3-listen");
    const lines = await watch.done;
    const tone = lines.filter((line) => line.bundle === TONE_BUNDLE_ID);
    const latency = (log, key) => {
      const events = readTone(log);
      const started = events.find((e) => e.event === "started");
      const stopped = events.find((e) => e.event === "stopped");
      const on = started && tone.find((line) => line[key] && line.t >= started.t - PROC_GAP_MS);
      const off = stopped && tone.find((line) => !line[key] && line.t >= stopped.t - PROC_GAP_MS);
      return {
        toneEvents: events,
        detectedOnMs: on ? round(on.t - started.t) : null,
        detectedOffMs: off ? round(off.t - stopped.t) : null,
      };
    };
    // What a production-rate poll costs, measured over a quiet minute.
    const cost = spawnSync("/usr/bin/time", ["-l", HELPER, "procwatch", "--seconds", PROC_COST_SECONDS, "--poll-ms", PROC_POLL_MS], { encoding: "utf8" });
    const cpu = Number(/([\d.]+) user/.exec(cost.stderr)?.[1]) + Number(/([\d.]+) sys/.exec(cost.stderr)?.[1]);
    save("q3-procwatch", { pollMs: PROC_POLL_MS, output: latency(playLog, "output"), input: latency(listenLog, "input"),
      pollCost: { seconds: PROC_COST_SECONDS, cpuSec: round(cpu, 3), percentOfOneCore: round((cpu / PROC_COST_SECONDS) * 100, 3) },
      toneLines: tone });
  },

  /** Q4: log every process that changes mic or speaker use for --seconds (James runs calls). */
  async calls() {
    const seconds = Number(process.argv[3] ?? 300);
    console.error(`watching CoreAudio processes for ${seconds}s; start and end each test call now`);
    const lines = await background(["procwatch", "--seconds", seconds, "--poll-ms", PROC_POLL_MS]).done;
    save("q4-calls", { seconds, events: lines.filter((line) => "bundle" in line) });
  },

  /** Q5: Vision OCR speed and accuracy on rendered synthetic screenshots, at 1x and 2x. */
  ocr() {
    const spec = JSON.parse(fs.readFileSync(OCR_FIXTURES, "utf8"));
    const words = (text) => text.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
    const truthWords = spec.fixtures.reduce((sum, fixture) => sum + fixture.lines.flatMap((line) => words(line.text)).length, 0);
    // The first Vision request in a process loads the model; time it apart from steady state.
    const coldDir = path.join(OUT_DIR, "ocr-fixtures-1x");
    helper("render-fixtures", "--spec", OCR_FIXTURES, "--dir", coldDir, "--scale", 1);
    const [cold] = helper("ocr", path.join(coldDir, `${spec.fixtures[0].name}.png`));
    const rows = [];
    for (const scale of OCR_SCALES) {
      const dir = path.join(OUT_DIR, `ocr-fixtures-${scale}x`);
      helper("render-fixtures", "--spec", OCR_FIXTURES, "--dir", dir, "--scale", scale);
      // "merged" (PR 3b-1): accurate plus a thresholded pass, at point resolution only.
      for (const level of scale === 1 ? ["accurate", "fast", "merged"] : ["accurate", "fast"]) {
        // One process per level and scale, warmed by a throwaway first image.
        const files = [spec.fixtures[0], ...spec.fixtures].map((fixture) => path.join(dir, `${fixture.name}.png`));
        const results = helper("ocr", "--level", level, "--text", "1", ...files).slice(1);
        spec.fixtures.forEach((fixture, index) => {
          const found = new Set(words(results[index].text.join(" ")));
          const truth = fixture.lines.flatMap((line) => words(line.text));
          const hits = truth.filter((word) => found.has(word)).length;
          rows.push({ scale, level, fixture: fixture.name, ms: results[index].ms, hits, truthWords: truth.length,
            wordRecall: round(hits / truth.length, 3) });
        });
      }
    }
    const summary = {};
    for (const scale of OCR_SCALES) {
      for (const level of scale === 1 ? ["accurate", "fast", "merged"] : ["accurate", "fast"]) {
        const set = rows.filter((row) => row.level === level && row.scale === scale);
        summary[`${scale}x-${level}`] = {
          meanMs: round(set.reduce((sum, row) => sum + row.ms, 0) / set.length),
          maxMs: round(Math.max(...set.map((row) => row.ms))),
          pooledWordRecall: round(set.reduce((sum, row) => sum + row.hits, 0) / truthWords, 3),
          worstFixture: set.reduce((worst, row) => (row.wordRecall < worst.wordRecall ? row : worst)),
        };
      }
    }
    save("q5-ocr", { canvasPoints: `${spec.width}x${spec.height}`, coldFirstRequestMs: cold.ms, summary, rows });
  },

  /** Q6a: real screen capture at the shortest interval; `shots-analyze` replays it at 2x and 4x. */
  async shots() {
    const minutes = Number(process.argv[3] ?? 60);
    const dir = path.join(OUT_DIR, "shots");
    fs.rmSync(dir, { recursive: true, force: true });
    await background(["shots", "--dir", dir, "--interval", SHOT_INTERVALS_SEC[0],
      "--duration", minutes * 60, "--ocr", "1"], path.join(OUT_DIR, "shots.jsonl")).done;
    commands["shots-analyze"]();
  },

  "shots-analyze"() {
    const lines = jsonLines(fs.readFileSync(path.join(OUT_DIR, "shots.jsonl"), "utf8"));
    const frames = lines.filter((line) => "i" in line);
    const threshold = Number(process.env.GS_SPIKE_HAMMING ?? 8);
    const bits = (hex) => [...hex].flatMap((c) => parseInt(c, 16).toString(2).padStart(4, "0").split("").map(Number));
    const distance = (a, b) => a.reduce((sum, bit, i) => sum + (bit !== b[i] ? 1 : 0), 0);
    // Measured span (last tick start + one interval), not ticks x interval: slow ticks
    // stretch the real hour.
    const spanHours = (frames.at(-1).t + SHOT_INTERVALS_SEC[0]) / SECONDS_PER_HOUR;
    const result = { frames: frames.length, spanMinutes: round(spanHours * 60, 1), hammingThreshold: threshold, intervals: {} };
    // CPU per tick splits into a base part (capture, hash, encode) paid by every tick, and
    // OCR paid only by kept frames. A frame the 2x/4x replay keeps but the 15 s run skipped
    // was never OCR'd, so it is charged the mean measured OCR CPU (Codex review of PR 71).
    const ocrFrames = frames.filter((f) => !f.skipped && f.ocrCpuSec !== undefined);
    const meanOcrCpu = ocrFrames.length ? ocrFrames.reduce((sum, f) => sum + f.ocrCpuSec, 0) / ocrFrames.length : null;
    if (meanOcrCpu === null) throw new Error("no ocrCpuSec in shots.jsonl: re-run `shots` with the current helper");
    const baseCpu = (f) => f.cpuSec - (f.ocrCpuSec ?? 0);
    for (const interval of SHOT_INTERVALS_SEC) {
      const step = interval / SHOT_INTERVALS_SEC[0];
      const ticks = frames.filter((f) => f.i % step === 0);
      let last = null;
      let kept = 0;
      let bytes = 0;
      let cpu = 0;
      for (const frame of ticks) {
        const hash = bits(frame.hash);
        cpu += baseCpu(frame);
        if (last && distance(last, hash) <= threshold) continue;
        last = hash;
        kept += 1;
        bytes += frame.bytes;
        cpu += frame.skipped ? meanOcrCpu : frame.ocrCpuSec;
      }
      const perHourMb = bytes / BYTES_PER_MB / spanHours;
      result.intervals[interval] = {
        ticks: ticks.length, kept,
        mbPerHour: round(perHourMb), mbPer8hDay: round(perHourMb * WORK_HOURS_PER_DAY),
        gbPer30Days: round((perHourMb * WORK_HOURS_PER_DAY * RETENTION_DAYS) / 1000),
        helperCpuSecPerHour: round(cpu / spanHours, 1),
        helperCpuPercentOfOneCore: round((cpu / (spanHours * SECONDS_PER_HOUR)) * 100, 3),
      };
    }
    result.cpuModel = {
      meanBaseCpuSecPerTick: round(frames.reduce((sum, f) => sum + baseCpu(f), 0) / frames.length, 4),
      meanOcrCpuSecPerKeptFrame: round(meanOcrCpu, 4), ocrMeasuredFrames: ocrFrames.length,
    };
    const kept = frames.filter((f) => !f.skipped);
    result.perFrame = {
      meanCaptureMs: round(frames.reduce((s, f) => s + f.captureMs, 0) / frames.length),
      meanEncodeMs: round(frames.reduce((s, f) => s + f.encodeMs, 0) / frames.length),
      meanHeicKB: round(frames.reduce((s, f) => s + f.bytes, 0) / frames.length / 1000, 1),
      meanOcrMsKept: kept.length ? round(kept.reduce((s, f) => s + f.ocrMs, 0) / kept.length) : null,
    };
    result.audioOpusMbPerHourPerStream = round((AUDIO_OPUS_KBPS * 1000 * SECONDS_PER_HOUR) / 8 / BYTES_PER_MB, 1);
    save("q6-shots", result);
  },

  /** Q6b: whisper base.en vs small.en on synthetic speech (macOS `say`), scored by WER. */
  whisper() {
    const script = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "day-recorder", "speech-script.json"), "utf8"));
    if (!script.header.startsWith("SYNTHETIC")) throw new Error("speech script is not headed SYNTHETIC");
    const text = script.paragraphs.join(" ");
    const aiff = path.join(OUT_DIR, "speech.aiff");
    const wav = path.join(OUT_DIR, "speech.wav");
    fs.mkdirSync(OUT_DIR, { recursive: true });
    run("say", ["-o", aiff, text]);
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ar", String(SPEECH_SAMPLE_RATE), "-ac", "1", wav]);
    const audioSec = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).trim());
    // Clean TTS is too easy to separate the models, so also score it under pink noise.
    const noisyWav = path.join(OUT_DIR, "speech-noisy.wav");
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=${NOISE_AMPLITUDE}:sample_rate=${SPEECH_SAMPLE_RATE}`,
      "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0", "-ac", "1", noisyWav]);
    const words = (t) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
    const wer = (ref, hyp) => {
      const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
      for (let j = 1; j <= hyp.length; j += 1) d[0][j] = j;
      for (let i = 1; i <= ref.length; i += 1) {
        for (let j = 1; j <= hyp.length; j += 1) {
          d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
        }
      }
      return d[ref.length][hyp.length] / ref.length;
    };
    // Number words and digits are the same words to a reader; score them as one form.
    const NUMBER_FORMS = { "40%": "forty percent", "28th": "twenty eighth", "4th": "fourth" };
    const normalise = (t) => words(Object.entries(NUMBER_FORMS).reduce((acc, [from, to]) => acc.split(from).join(to), t.toLowerCase()));
    const models = {};
    for (const [variant, input] of [["clean", wav], ["noisy", noisyWav]]) for (const name of WHISPER_MODELS) {
      const model = path.join(WHISPER_MODEL_DIR, name);
      const key = `${variant}:${name}`;
      if (!fs.existsSync(model)) { models[key] = { missing: model }; continue; }
      const outBase = path.join(OUT_DIR, `whisper-${variant}-${name}`);
      const started = performance.now();
      // /usr/bin/time -l reports the child's user/sys CPU and peak RSS on stderr.
      const timed = spawnSync("/usr/bin/time", ["-l", "whisper-cli", "-m", model, "-f", input, "-otxt", "-of", outBase, "-np"], { encoding: "utf8" });
      const wallSec = (performance.now() - started) / 1000;
      if (timed.status !== 0) throw new Error(`whisper-cli ${name} exited ${timed.status}: ${timed.stderr.slice(-1_000)}`);
      const user = Number(/([\d.]+) user/.exec(timed.stderr)?.[1]);
      const sys = Number(/([\d.]+) sys/.exec(timed.stderr)?.[1]);
      const rss = Number(/(\d+)\s+maximum resident set size/.exec(timed.stderr)?.[1]);
      const hyp = fs.readFileSync(`${outBase}.txt`, "utf8");
      models[key] = {
        wallSec: round(wallSec), cpuSec: round(user + sys), realtimeFactor: round(wallSec / audioSec, 3),
        cpuSecPerAudioHour: round(((user + sys) / audioSec) * SECONDS_PER_HOUR),
        peakRssMB: round(rss / BYTES_PER_MB), wer: round(wer(words(text), words(hyp)), 4),
        werNumbersNormalised: round(wer(normalise(text), normalise(hyp)), 4),
      };
    }
    save("q6-whisper", { audioSec: round(audioSec), words: words(text).length, models });
  },

  /**
   * Q8 (F4): does ANTHROPIC_API_KEY in the environment move the Agent SDK onto API-key
   * billing? Both runs point the SDK at a local server that answers 401 to everything, so
   * no request can reach Anthropic and nothing can be billed. The server records only
   * header NAMES and which kind of credential arrived, never a credential value.
   */
  async "sdk-billing"() {
    const http = await import("node:http");
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const seen = [];
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      const apiKey = req.headers["x-api-key"];
      seen.push({
        method: req.method, path: req.url.split("?")[0], headerNames: Object.keys(req.headers).sort(),
        xApiKey: apiKey === undefined ? "absent" : apiKey === FAKE_API_KEY ? "the fake test key" : "some other value",
        authorization: !auth ? "absent" : auth.startsWith("Bearer sk-ant-oat") ? "Bearer <OAuth access token>" : "present, not an OAuth token",
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "spike: deliberately refused" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const attempt = async (label, withKey) => {
      // Start from the environment a Dock-launched Electron app has: nothing from a
      // Claude Code host session (a parent session exports its own auth variables, which
      // would decide the answer instead of the SDK's normal credential lookup).
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/.test(key)));
      Object.assign(env, { ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
      if (withKey) env.ANTHROPIC_API_KEY = FAKE_API_KEY;
      const before = seen.length;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SDK_PROBE_TIMEOUT_MS);
      const result = { label, apiKeySource: null, firstResult: null, error: null };
      try {
        for await (const message of query({ prompt: "Reply with OK.", options: {
          env, tools: [], settingSources: [], maxTurns: 1, abortController: abort, cwd: OUT_DIR } })) {
          if (message.type === "system" && message.subtype === "init") result.apiKeySource = message.apiKeySource;
          if (message.type === "result") {
            result.firstResult = { subtype: message.subtype, isError: message.is_error, totalCostUsd: message.total_cost_usd };
            break;
          }
        }
      } catch (error) {
        result.error = error.message.slice(0, 300);
      } finally {
        clearTimeout(timer);
      }
      const requests = seen.slice(before).filter((request) => request.path === "/v1/messages");
      result.messagesRequests = requests.length;
      result.credentialSent = [...new Set(requests.map((request) => `x-api-key: ${request.xApiKey}; authorization: ${request.authorization}`))];
      return result;
    };
    const runs = [await attempt("no ANTHROPIC_API_KEY (ARCHITECT today)", false), await attempt("ANTHROPIC_API_KEY set", true)];
    server.close();
    save("q8-sdk-billing", { sdkVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")).version, baseUrl, runs });
  },

  /**
   * R2: audio lost at each MediaRecorder stop/restart boundary, and whether each segment
   * decodes to 16 kHz WAV on its own (the meetingProcessor.mjs ffmpeg arguments).
   */
  "segment-gap"() {
    const dir = path.join(OUT_DIR, "segments");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    run(path.join(ROOT, "node_modules", ".bin", "electron"), [path.join(ROOT, "scripts", "spike", "segment-gap.cjs")], {
      env: { ...process.env, GS_SEGMENT_DIR: dir, GS_SEGMENTS: String(GAP_SEGMENTS), GS_SEGMENT_MS: String(GAP_SEGMENT_MS) },
    });
    const recorded = JSON.parse(fs.readFileSync(path.join(dir, "segments.json"), "utf8"));
    const result = { segments: GAP_SEGMENTS, segmentMs: GAP_SEGMENT_MS, strategies: {} };
    for (const [strategy, segments] of Object.entries(recorded)) {
      const decoded = segments.map((segment) => {
        const wav = segment.file.replace(/\.webm$/, ".wav");
        const decode = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", segment.file, "-ar", "16000", "-ac", "1", wav], { encoding: "utf8" });
        const seconds = decode.status === 0
          ? Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).trim()) : null;
        return { file: path.basename(segment.file), bytes: segment.bytes, decodesAlone: decode.status === 0,
          decodeError: decode.status === 0 ? null : decode.stderr.trim().slice(0, 300), decodedMs: seconds === null ? null : round(seconds * 1000) };
      });
      const boundaries = segments.slice(1).map((segment, i) => round(segment.onstartAt - segments[i].stopCalledAt));
      const wallMs = segments.at(-1).stopCalledAt - segments[0].onstartAt;
      const decodedMs = decoded.reduce((sum, d) => sum + (d.decodedMs ?? 0), 0);
      result.strategies[strategy] = {
        restartGapMs: boundaries,
        wallSpanMs: round(wallMs), decodedTotalMs: round(decodedMs),
        lostMsPerBoundary: round((wallMs - decodedMs) / boundaries.length),
        allDecodeAlone: decoded.every((d) => d.decodesAlone), decoded,
      };
    }
    save("r2-segment-gap", result);
  },

  /** Q9 (F8): does a non-root `tmutil addexclusion` stick, and does isexcluded confirm it? */
  tmutil() {
    const dir = fs.mkdtempSync(path.join(OUT_DIR, "tm-exclusion-"));
    const uid = process.getuid();
    const add = spawnSync("tmutil", ["addexclusion", dir], { encoding: "utf8" });
    const check = spawnSync("tmutil", ["isexcluded", dir], { encoding: "utf8" });
    const xattr = spawnSync("xattr", ["-p", "com.apple.metadata:com_apple_backup_excludeItem", dir], { encoding: "utf8" });
    const fixedPath = spawnSync("tmutil", ["addexclusion", "-p", dir], { encoding: "utf8" });
    save("q9-tmutil", {
      uid, euidIsRoot: process.geteuid() === 0, dir,
      addexclusion: { status: add.status, stderr: add.stderr.trim() },
      isexcluded: { status: check.status, stdout: check.stdout.trim() },
      stickyXattrPresent: xattr.status === 0,
      fixedPathVariant: { status: fixedPath.status, stderr: fixedPath.stderr.trim() },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  },
};

const name = process.argv[2];
if (!commands[name]) {
  console.error(`usage: node scripts/spike-day-recorder.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
if (process.platform !== "darwin") {
  console.error("spike-day-recorder is macOS-only (ScreenCaptureKit, CoreAudio, Vision)");
  process.exit(2);
}
try {
  await commands[name]();
} catch (error) {
  console.error(`spike ${name} failed: ${error.message}`);
  process.exit(1);
}
