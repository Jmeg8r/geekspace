#!/usr/bin/env node
// WHAT: live probe for Day Recorder transcription (plan PR 5, spec R7): the real ffmpeg,
// whisper.cpp and small.en, on synthetic audio only.
//   1. speech made by macOS `say` from a fixed sentence → the transcript has its words;
//   2. two seconds of silence → reported silent, no transcript;
//   3. the same speech as Opus WebM (the mic's format) → transcribed too.
// WHY a probe, not a vitest suite: CI has neither whisper nor the model (probe:segment-decode).
// Usage: node scripts/probe-transcribe.mjs   (macOS; exits non-zero on any failure)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFfmpeg, transcribeFile } from "../electron/meetingProcessor.mjs";

// SYNTHETIC: a fixed sentence, spoken by the system voice.
const SENTENCE = "Schedule the quarterly planning review for Thursday afternoon and send the agenda to the team.";
const WORDS = ["schedule", "quarterly", "planning", "review", "thursday", "agenda", "team"];
const SILENCE_SEC = 2;

const words = (text) => text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

async function main() {
  if (process.platform !== "darwin") throw new Error("this probe uses macOS `say`");
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg not found");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-probe-transcribe-"));
  try {
    const aiff = path.join(dir, "speech.aiff");
    const webm = path.join(dir, "speech.webm");
    const silent = path.join(dir, "silent.wav");
    execFileSync("say", ["-o", aiff, SENTENCE]);
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", aiff, "-c:a", "libopus", "-b:a", "32k", webm]);
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `anullsrc=r=16000:cl=mono`, "-t", String(SILENCE_SEC), silent]);

    const started = Date.now();
    const speech = await transcribeFile({ input: aiff, model: "small.en" });
    const speechMs = Date.now() - started;
    const opus = await transcribeFile({ input: webm, model: "small.en" });
    const quiet = await transcribeFile({ input: silent, model: "small.en" });

    const heard = "transcript" in speech ? words(speech.transcript) : [];
    const heardOpus = "transcript" in opus ? words(opus.transcript) : [];
    const checks = {
      speechTranscribed: WORDS.every((w) => heard.includes(w)),
      opusWebmTranscribed: WORDS.every((w) => heardOpus.includes(w)),
      silenceIsSilent: quiet.silent === true && !("transcript" in quiet),
    };
    console.log(JSON.stringify({ checks, speechMs, expectedWordsHeard: WORDS.filter((w) => heard.includes(w)).length, of: WORDS.length }, null, 2));
    const failed = Object.entries(checks).filter(([, ok]) => !ok);
    if (failed.length) throw new Error(`failed: ${failed.map(([k]) => k).join(", ")}`);
    console.log("PASS");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`probe-transcribe: ${err.message}`);
  process.exit(1);
});
