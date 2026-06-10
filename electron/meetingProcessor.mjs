// WHAT: The local AI meeting-notes pipeline — runs entirely on this Mac.
//   audio (webm/opus) → ffmpeg → 16kHz wav → whisper.cpp → transcript
//   transcript → local Ollama → { summary, key points, decisions, action items }
// WHY main-process: child processes + localhost HTTP without CORS ceremony.
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const MODEL_DIR = path.join(os.homedir(), ".geekspace", "whisper-models");
const MODEL_NAME = "ggml-base.en.bin";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`;
const TOOL_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const MAX_TRANSCRIPT_CHARS_FOR_LLM = 24_000;

async function findTool(names) {
  for (const dir of TOOL_PATHS) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        await fs.access(p);
        return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export async function toolStatus() {
  const ffmpeg = await findTool(["ffmpeg"]);
  const whisper = await findTool(["whisper-cli", "whisper-cpp"]);
  let model = false;
  try {
    const stat = await fs.stat(path.join(MODEL_DIR, MODEL_NAME));
    model = stat.size > 100_000_000; // a partial download doesn't count
  } catch {
    model = false;
  }
  return { ffmpeg: Boolean(ffmpeg), whisper: Boolean(whisper), model, modelName: MODEL_NAME };
}

/** Download the whisper model with progress callbacks (0-100). */
export async function ensureModel(onProgress) {
  const status = await toolStatus();
  if (status.model) return true;
  await fs.mkdir(MODEL_DIR, { recursive: true });
  const dest = path.join(MODEL_DIR, MODEL_NAME);
  const tmp = `${dest}.part`;

  await new Promise((resolve, reject) => {
    const fetchFrom = (url, redirectsLeft) => {
      https
        .get(url, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) return reject(new Error("Too many redirects"));
            res.resume();
            return fetchFrom(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Model download failed (HTTP ${res.statusCode})`));
          }
          const total = Number(res.headers["content-length"] ?? 0);
          let got = 0;
          const file = createWriteStream(tmp);
          res.on("data", (chunk) => {
            got += chunk.length;
            if (total > 0) onProgress?.(Math.round((got / total) * 100));
          });
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", reject);
          res.on("error", reject);
        })
        .on("error", reject);
    };
    fetchFrom(MODEL_URL, 5);
  });
  await fs.rename(tmp, dest);
  return true;
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

function buildPrompt(transcript, meetingType, truncated) {
  const focus = TYPE_FOCUS[meetingType] ?? TYPE_FOCUS.general;
  return `You are an expert meeting-notes assistant. Below is a raw meeting transcript${truncated ? " (truncated)" : ""} from an automatic speech recognizer — expect missing punctuation and occasional mis-heard words.

Meeting type: ${meetingType.replace(/_/g, " ")}. ${focus}

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"summary": "2-4 short paragraphs separated by \\n\\n", "key_points": ["..."], "decisions": ["..."], "action_items": ["..."]}

Rules:
- Be faithful to the transcript; never invent facts, names, or dates.
- action_items start with a verb; include the owner and due date when mentioned.
- decisions are things that were settled; key_points are important discussion topics.
- Use empty arrays when a category has nothing.

TRANSCRIPT:
${transcript}`;
}

async function summarize(transcript, meetingType, ollamaUrl, ollamaModel) {
  const base = (ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const tags = await checkOllama(base);
  if (!tags.ok) throw new Error(tags.error);
  const model =
    ollamaModel && tags.models.includes(ollamaModel)
      ? ollamaModel
      : (tags.models.find((m) => m.startsWith("gemma")) ??
        tags.models.find((m) => !m.includes("embed")) ??
        tags.models[0]);
  if (!model) throw new Error("No Ollama models installed");

  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS_FOR_LLM;
  const text = truncated ? transcript.slice(0, MAX_TRANSCRIPT_CHARS_FOR_LLM) : transcript;

  // WHY /api/generate: /api/chat returns empty content for some local models
  // (seen with gemma on Ollama 0.20).
  const res = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: buildPrompt(text, meetingType, truncated),
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
  const strArray = (x) =>
    Array.isArray(x) ? x.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : [];
  return {
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "No summary produced.",
    keyPoints: strArray(parsed.key_points),
    decisions: strArray(parsed.decisions),
    actionItems: strArray(parsed.action_items),
    modelUsed: model,
  };
}

/**
 * Full pipeline. `audio` is a Buffer/Uint8Array of the recorded webm.
 * onProgress({ phase, pct }) fires throughout.
 */
export async function processMeeting({ audio, meetingType, ollamaUrl, ollamaModel }, onProgress) {
  const status = await toolStatus();
  if (!status.ffmpeg) throw new Error("ffmpeg not found — `brew install ffmpeg`");
  if (!status.whisper) throw new Error("whisper.cpp not found — `brew install whisper-cpp`");
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
    await run(ffmpeg, ["-y", "-i", webm, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 10 * 60 * 1000);
    const transcript = await runWhisper(whisper, modelPath, wav, (pct) =>
      onProgress?.({ phase: "transcribing", pct })
    );
    if (!transcript || transcript.replace(/[\s[\]BLANK_AUDIO()]+/gi, "").length < 5) {
      throw new Error("No speech detected in the recording");
    }

    onProgress?.({ phase: "summarizing", pct: 0 });
    const summary = await summarize(transcript, meetingType ?? "general", ollamaUrl, ollamaModel);
    return { transcript, ...summary };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
