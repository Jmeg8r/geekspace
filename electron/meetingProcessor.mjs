// WHAT: The local AI meeting-notes pipeline — runs entirely on this Mac.
//   audio (webm/opus) → ffmpeg → 16kHz wav → whisper.cpp → transcript
//   transcript → local Ollama → { summary, key points, decisions, action items }
// WHY main-process: child processes + localhost HTTP without CORS ceremony.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadVerifiedFile, verifiedFile } from "./verifiedDownload.mjs";

// WHY: Windows executables carry the .exe suffix; used when probing for
// ffmpeg/whisper-cli so we look for the name Windows actually resolves.
const EXE = process.platform === "win32" ? ".exe" : "";

const MODEL_DIR = path.join(os.homedir(), ".geekspace", "whisper-models");
const MODEL_NAME = "ggml-base.en.bin";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
// WHY pinned: a size check alone accepted any file over 100 MB as the model.
// Hugging Face LFS metadata (x-linked-size / x-linked-etag), checked 2026-10-15 against
// both the CDN and an installed copy.
const MODEL_SIZE = 147_964_211;
const MODEL_SHA256 = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
// WHY win32 gets a 4th dir: whisper.cpp ships no winget package, so
// ~/.geekspace/tools is the documented drop-dir for whisper-cli.exe. The three
// mac dirs stay exactly as-is and in order on every platform.
const TOOL_PATHS =
  process.platform === "win32"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(os.homedir(), ".geekspace", "tools")]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
// WHY 24k: about 6k tokens, leaving the 16k context room for the prompt and the reply.
// Longer transcripts are summarised section by section, then merged.
const SECTION_CHARS = 24_000;

// WHAT: dB floors separating a usable recording from a dead input device.
// WHY: calibrated against real recordings from this app. A healthy 73-min
// meeting measured mean -24.0 dB / peak 0.0 dB. Two silent-input sessions
// measured mean -91.0 dB / peak -58.5 dB (stone-dead device) and mean
// -76.5 dB / peak -13.0 dB (brief bursts, nothing else). Both floors are
// needed: the peak floor catches a fully dead device, the mean floor catches
// one that only blips — a peak-only check would have passed the second case.
const SILENT_PEAK_DB = -45;
const SILENT_MEAN_DB = -70;

async function findTool(names) {
  // WHY also scan PATH: winget/choco installs land on PATH, and a packaged
  // Windows app inherits the registry PATH — unlike a mac app launched from
  // Finder with a stripped-down PATH, which is why TOOL_PATHS above has to be
  // hardcoded in the first place.
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const dirs = [...TOOL_PATHS, ...pathDirs];
  for (const dir of dirs) {
    for (const name of names) {
      // Try the platform-appropriate suffix first. EXE is "" on mac, so
      // `candidates` collapses to [name] there and behavior is unchanged.
      const candidates = EXE ? [name + EXE, name] : [name];
      for (const candidate of candidates) {
        const p = path.join(dir, candidate);
        try {
          await fs.access(p);
          return p;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

// WHY cache: hashing 148 MB takes a moment and toolStatus runs on every Meetings visit.
// Keyed by inode, size and mtime, so a replaced or truncated file is hashed again.
let modelCheck = { key: "", ok: false };
async function modelVerified() {
  const file = path.join(MODEL_DIR, MODEL_NAME);
  let key;
  try {
    const st = await fs.lstat(file);
    key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  if (modelCheck.key !== key) {
    modelCheck = { key, ok: await verifiedFile(file, MODEL_SIZE, MODEL_SHA256) };
  }
  return modelCheck.ok;
}

export async function toolStatus() {
  const ffmpeg = await findTool(["ffmpeg"]);
  const whisper = await findTool(["whisper-cli", "whisper-cpp"]);
  const model = await modelVerified();
  return { ffmpeg: Boolean(ffmpeg), whisper: Boolean(whisper), model, modelName: MODEL_NAME };
}

let modelDownload = null;
/** Download the whisper model (progress 0-100). Concurrent callers share one download. */
export async function ensureModel(onProgress) {
  if (modelDownload) return modelDownload;
  modelDownload = (async () => {
    if (await modelVerified()) return true;
    await fs.mkdir(MODEL_DIR, { recursive: true });
    await downloadVerifiedFile(MODEL_URL, path.join(MODEL_DIR, MODEL_NAME), MODEL_SIZE, MODEL_SHA256, onProgress);
    return true;
  })();
  try {
    return await modelDownload;
  } finally {
    modelDownload = null;
  }
}

export async function checkOllama(url) {
  const base = (url || "http://127.0.0.1:11434").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `Ollama responded ${res.status}`, models: [] };
    const data = await res.json();
    return { ok: true, models: (data.models ?? []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: `Ollama not reachable at ${base}`, models: [] };
  }
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(0, 400)));
      else resolve(String(stdout));
    });
  });
}

/**
 * Parse ffmpeg's `volumedetect` stderr into dB stats.
 * Returns NaN for a field ffmpeg didn't report; -Infinity for its "-inf".
 */
export function parseVolumeStats(stderr) {
  const read = (label) => {
    const m = String(stderr).match(new RegExp(`${label}:\\s*(-?[\\d.]+|-inf)\\s*dB`, "i"));
    if (!m) return NaN;
    return m[1] === "-inf" ? -Infinity : Number(m[1]);
  };
  return { meanDb: read("mean_volume"), peakDb: read("max_volume") };
}

/** True when the audio carries no usable speech signal. */
export function isSilentAudio({ meanDb, peakDb }) {
  // WHY fail open: if ffmpeg didn't report levels we can't judge the audio,
  // so let whisper try rather than discarding a possibly-good recording.
  if (Number.isNaN(meanDb) || Number.isNaN(peakDb)) return false;
  return peakDb < SILENT_PEAK_DB || meanDb < SILENT_MEAN_DB;
}

function fmtDb(db) {
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : "silence";
}

/** The ffmpeg binary, or null. Exported for probe:segment-decode. */
export function findFfmpeg() {
  return findTool(["ffmpeg"]);
}

/**
 * Decode any audio ffmpeg reads into the 16 kHz mono wav whisper takes. Exported so
 * probe:segment-decode checks a Day Recorder segment through exactly this path.
 */
export function convertToWhisperWav(ffmpegBin, input, wav) {
  return run(ffmpegBin, ["-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 10 * 60 * 1000);
}

/** Measure a wav's levels with ffmpeg volumedetect (fast — it decodes only). */
export function measureVolume(ffmpegBin, wavPath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegBin,
      ["-hide_banner", "-i", wavPath, "-af", "volumedetect", "-f", "null", "-"],
      { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      // WHY ignore the error: this is a guard, not a pipeline stage. A failed
      // measurement yields NaNs, which isSilentAudio() treats as "can't tell".
      (_err, _stdout, stderr) => resolve(parseVolumeStats(stderr)),
    );
  });
}

/** whisper.cpp with stderr progress parsing. Returns the plain transcript. */
function runWhisper(whisperBin, modelPath, wavPath, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(whisperBin, [
      "-m", modelPath,
      "-f", wavPath,
      "-nt", // no timestamps — clean prose transcript
      "--print-progress",
    ]);
    let stdout = "";
    let stderr = "";
    const killer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Transcription timed out (30 min)"));
    }, 30 * 60 * 1000);
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
      const matches = String(d).match(/progress\s*=\s*(\d+)%/g);
      if (matches) {
        const last = matches[matches.length - 1].match(/(\d+)%/);
        // WHY clamp: whisper's progress callback can exceed 100% on short clips.
        if (last) onProgress?.(Math.min(100, Number(last[1])));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0) reject(new Error(`whisper exited ${code}: ${stderr.slice(-300)}`));
      else resolve(stdout.replace(/\r/g, "").trim());
    });
  });
}

const TYPE_FOCUS = {
  general: "Capture what was discussed, what was decided, and what happens next.",
  standup: "Focus on status updates, blockers, and who is doing what next. Keep it tight.",
  one_on_one: "Focus on feedback exchanged, growth topics, concerns raised, and follow-ups each person owes.",
  client: "Focus on client needs and requirements, commitments made (by whom, by when), risks, and next steps.",
  interview: "Focus on the candidate: background highlights, strengths, concerns, notable answers, and recommended next steps.",
  brainstorm: "Focus on the ideas generated — list them faithfully — plus emerging themes and which directions were chosen or parked.",
};

/** True when whisper heard nothing but its own non-speech markers ([BLANK_AUDIO], (silence)…). */
export function isNoSpeech(transcript) {
  const speech = String(transcript ?? "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/\s+/g, "");
  return speech.length < 5;
}

const NOTES_SHAPE = `{"summary": "2-4 short paragraphs separated by \\n\\n", "key_points": ["..."], "decisions": ["..."], "action_items": ["..."]}`;

const NOTES_RULES = `Rules:
- Be faithful to the source; never invent facts, names, or dates.
- action_items start with a verb; include the owner and due date when mentioned.
- decisions are things that were settled; key_points are important discussion topics.
- Use empty arrays when a category has nothing.`;

function buildPrompt(transcript, meetingType, part) {
  const focus = TYPE_FOCUS[meetingType] ?? TYPE_FOCUS.general;
  const which = part ? ` This is section ${part.index} of ${part.count} of a longer meeting; cover only this section.` : "";
  return `You are an expert meeting-notes assistant. Below is a raw meeting transcript from an automatic speech recognizer — expect missing punctuation and occasional mis-heard words.${which}

Meeting type: ${meetingType.replace(/_/g, " ")}. ${focus}

Respond with ONLY a JSON object, no other text, in exactly this shape:
${NOTES_SHAPE}

${NOTES_RULES}

TRANSCRIPT:
${transcript}`;
}

function buildMergePrompt(partials, meetingType) {
  const focus = TYPE_FOCUS[meetingType] ?? TYPE_FOCUS.general;
  const sections = partials.map((p, i) => `Section ${i + 1}: ${JSON.stringify(p)}`).join("\n");
  return `You are an expert meeting-notes assistant. A long meeting was summarised in ${partials.length} consecutive sections. Merge the partial notes below into one set of notes for the whole meeting: combine duplicates, keep every distinct decision and action item, and write the summary for the meeting as a whole.

Meeting type: ${meetingType.replace(/_/g, " ")}. ${focus}

Respond with ONLY a JSON object, no other text, in exactly this shape:
${NOTES_SHAPE}

${NOTES_RULES}

PARTIAL NOTES:
${sections}`;
}

/** Split on whitespace into sections of at most `max` characters (a longer word stands alone). */
function splitSections(text, max) {
  const sections = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > max) {
      sections.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) sections.push(current);
  return sections;
}

async function pickModel(base, ollamaModel) {
  const tags = await checkOllama(base);
  if (!tags.ok) throw new Error(tags.error);
  const model =
    ollamaModel && tags.models.includes(ollamaModel)
      ? ollamaModel
      : (tags.models.find((m) => m.startsWith("gemma")) ??
        tags.models.find((m) => !m.includes("embed")) ??
        tags.models[0]);
  if (!model) throw new Error("No Ollama models installed");
  return model;
}

/** One generate call → validated notes. Throws rather than inventing a placeholder. */
async function generateNotes(base, model, prompt) {
  // WHY /api/generate: /api/chat returns empty content for some local models
  // (seen with gemma on Ollama 0.20).
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: 0.2, num_ctx: 16384 },
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Ollama generate failed (${res.status})`);
  const data = await res.json();
  const raw = String(data.response ?? "");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("Model returned unparseable summary");
    parsed = JSON.parse(raw.slice(start, end + 1));
  }
  if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("Model returned no usable summary");
  }
  const strArray = (x) =>
    Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : [];
  return {
    summary: parsed.summary.trim(),
    keyPoints: strArray(parsed.key_points),
    decisions: strArray(parsed.decisions),
    actionItems: strArray(parsed.action_items),
  };
}

/** Transcript → notes. Long transcripts go section by section, then one merge pass. */
export async function summarizeTranscript(transcript, meetingType, ollamaUrl, ollamaModel, onProgress) {
  const base = (ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = await pickModel(base, ollamaModel);
  const type = meetingType || "general";
  const sections = splitSections(transcript, SECTION_CHARS);
  if (sections.length <= 1) {
    return { ...(await generateNotes(base, model, buildPrompt(transcript, type))), modelUsed: model };
  }
  const partials = [];
  for (const [i, section] of sections.entries()) {
    onProgress?.(Math.round((i / (sections.length + 1)) * 100));
    partials.push(await generateNotes(base, model, buildPrompt(section, type, { index: i + 1, count: sections.length })));
  }
  onProgress?.(Math.round((sections.length / (sections.length + 1)) * 100));
  return { ...(await generateNotes(base, model, buildMergePrompt(partials, type))), modelUsed: model };
}

/**
 * Summarise, but never lose the transcript: a summary failure comes back as
 * `summaryError` next to the transcript so it can be saved and summarised again later.
 */
export async function notesFromTranscript(transcript, meetingType, ollamaUrl, ollamaModel, onProgress) {
  try {
    return { transcript, ...(await summarizeTranscript(transcript, meetingType, ollamaUrl, ollamaModel, onProgress)) };
  } catch (err) {
    return { transcript, summaryError: String(err?.message ?? err) };
  }
}

/**
 * Full pipeline. `audio` is a Buffer/Uint8Array of the recorded webm.
 * onProgress({ phase, pct }) fires throughout.
 */
export async function processMeeting({ audio, meetingType, ollamaUrl, ollamaModel }, onProgress) {
  const status = await toolStatus();
  if (!status.ffmpeg) {
    throw new Error(
      process.platform === "win32"
        ? "ffmpeg not found — `winget install Gyan.FFmpeg`"
        : "ffmpeg not found — `brew install ffmpeg`"
    );
  }
  if (!status.whisper) {
    throw new Error(
      process.platform === "win32"
        ? "whisper.cpp not found — download the whisper.cpp Windows release zip and drop whisper-cli.exe into %USERPROFILE%\\.geekspace\\tools"
        : "whisper.cpp not found — `brew install whisper-cpp`"
    );
  }
  if (!status.model) {
    onProgress?.({ phase: "model", pct: 0 });
    await ensureModel((pct) => onProgress?.({ phase: "model", pct }));
  }
  const ffmpeg = await findTool(["ffmpeg"]);
  const whisper = await findTool(["whisper-cli", "whisper-cpp"]);
  const modelPath = path.join(MODEL_DIR, MODEL_NAME);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gs-meeting-"));
  try {
    const webm = path.join(tmp, "in.webm");
    const wav = path.join(tmp, "out.wav");
    await fs.writeFile(webm, Buffer.from(audio));

    onProgress?.({ phase: "transcribing", pct: 0 });
    await convertToWhisperWav(ffmpeg, webm, wav);

    // WHY here, before whisper: a dead input device (e.g. Bluetooth speakers
    // selected as the system input) yields a perfectly valid but silent stream.
    // whisper turns that into hallucinated filler ("you you you…") after a full
    // transcription run, which then summarizes into plausible-looking nonsense.
    // Checking the signal itself fails in seconds with an actionable message,
    // and catches every silent-input cause rather than one hallucination shape.
    const level = await measureVolume(ffmpeg, wav);
    if (isSilentAudio(level)) {
      // WHY the platform split: mirrors the renderer's copy (isMacLike in
      // src/lib/utils.ts) so the sound settings path names what the user sees.
      const soundSettings =
        process.platform === "darwin"
          ? "System Settings → Sound → Input"
          : "Settings → System → Sound → Input";
      throw new Error(
        `No audio captured — the recording is silent (peak ${fmtDb(level.peakDb)}, ` +
          `average ${fmtDb(level.meanDb)}). Check ${soundSettings} ` +
          `and select your microphone, then record again.`
      );
    }

    const transcript = await runWhisper(whisper, modelPath, wav, (pct) =>
      onProgress?.({ phase: "transcribing", pct })
    );
    if (isNoSpeech(transcript)) {
      throw new Error("No speech detected in the recording");
    }

    onProgress?.({ phase: "summarizing", pct: 0 });
    return notesFromTranscript(transcript, meetingType ?? "general", ollamaUrl, ollamaModel, (pct) =>
      onProgress?.({ phase: "summarizing", pct })
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
