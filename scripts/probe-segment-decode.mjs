#!/usr/bin/env node
// WHAT: npm run probe:segment-decode (plan PR 3d-2; Codex's PR #70 finding). Records mic
// segments through the real capture window, then decodes the SECOND segment on its own, in a
// folder without the first, to 16 kHz wav through Meetings' own ffmpeg path. It passes only
// if that segment decodes, has the expected length and is not silent. It also reports the
// gap at the boundary: the wall-clock span less the decoded lengths.
// WHY a probe, not a vitest suite: CI has no ffmpeg and no display, so a suite would skip
// silently (the same reason as probe:schema-failure). This exits non-zero without ffmpeg.
// Needs `npm run build` first (it loads dist/capture.html).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { convertToWhisperWav, findFfmpeg, isSilentAudio, measureVolume } from "../electron/meetingProcessor.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEGMENT_SEC = 3;
// The decoded length may differ from the segment's wall-clock length by container rounding
// and the restart gap; more than this means the file is truncated or padded.
const LENGTH_TOLERANCE_SEC = 0.5;
// 16 kHz, mono, 16-bit PCM, after a 44-byte header.
const WAV_BYTES_PER_SEC = 16_000 * 2;
const WAV_HEADER = 44;

function fail(message) {
  console.error(`probe:segment-decode FAILED: ${message}`);
  process.exit(1);
}

function runElectron(out) {
  // The electron package's main export is the path to its binary.
  const electron = createRequire(import.meta.url)("electron");
  return new Promise((resolve) => {
    const child = spawn(
      electron,
      [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        path.join(ROOT, "scripts", "probe", "segment-decode-main.mjs"),
      ],
      { env: { ...process.env, PROBE_OUT: out, PROBE_SEGMENT_SEC: String(SEGMENT_SEC) }, stdio: ["ignore", "ignore", "inherit"] }
    );
    child.on("error", (err) => fail(`could not start Electron: ${err.message}`));
    child.on("close", (code) => resolve(code));
  });
}

const wavSeconds = (file) => (fs.statSync(file).size - WAV_HEADER) / WAV_BYTES_PER_SEC;

const ffmpeg = await findFfmpeg();
if (!ffmpeg) fail("ffmpeg not found (brew install ffmpeg)");
if (!fs.existsSync(path.join(ROOT, "dist", "capture.html"))) fail("dist/capture.html is missing; run npm run build first");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "gs-probe-segment-"));
try {
  const code = await runElectron(out);
  const resultFile = path.join(out, "result.json");
  if (!fs.existsSync(resultFile)) fail(`the Electron half wrote no result (exit ${code})`);
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  if (code !== 0 || result.error) fail(`${result.error ?? `exit ${code}`}; log: ${result.logs.join(" | ")}`);
  const [first, second] = result.rows;
  if (!second) fail(`expected 2 segment rows, got ${result.rows.length}`);
  if (result.states.includes("error")) fail(`the mic reported an error: ${result.logs.join(" | ")}`);

  const decoded = [];
  for (const row of [first, second]) {
    // Each segment alone in its own folder, so nothing from another can help it decode.
    const alone = fs.mkdtempSync(path.join(out, "alone-"));
    const copy = path.join(alone, path.basename(row.path));
    fs.copyFileSync(path.join(out, "media", row.path), copy);
    const wav = path.join(alone, "out.wav");
    try {
      await convertToWhisperWav(ffmpeg, copy, wav);
    } catch (err) {
      fail(`${row.path} did not decode on its own: ${err.message}`);
    }
    decoded.push({ row, sec: wavSeconds(wav), level: await measureVolume(ffmpeg, wav) });
  }

  for (const d of decoded) {
    const wall = (d.row.end - d.row.start) / 1000;
    if (Math.abs(d.sec - wall) > LENGTH_TOLERANCE_SEC) {
      fail(`${d.row.path} decoded to ${d.sec.toFixed(2)} s, but it spans ${wall.toFixed(2)} s`);
    }
    if (isSilentAudio(d.level)) fail(`${d.row.path} decoded, but it is silent (peak ${d.level.peakDb} dB)`);
  }
  const span = (second.end - first.start) / 1000;
  const gapMs = Math.round((span - decoded[0].sec - decoded[1].sec) * 1000);
  console.log(
    `probe:segment-decode PASSED: segment 2 (${second.path}) decoded alone to ${decoded[1].sec.toFixed(2)} s ` +
      `of 16 kHz wav, peak ${decoded[1].level.peakDb.toFixed(1)} dB; segment 1 ${decoded[0].sec.toFixed(2)} s; ` +
      `boundary gap about ${gapMs} ms`
  );
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
