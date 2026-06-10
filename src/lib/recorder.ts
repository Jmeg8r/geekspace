// WHAT: Singleton microphone recorder — survives navigation while the floating
// widget shows state. MediaRecorder (webm/opus) + WebAudio analyser for levels.

export interface RecorderState {
  status: "idle" | "recording" | "paused";
  meetingId: string | null;
  title: string;
  meetingType: string;
  startedAt: number;
  elapsedSec: number;
  level: number; // 0..1 smoothed mic level
}

const idleState: RecorderState = {
  status: "idle",
  meetingId: null,
  title: "",
  meetingType: "general",
  startedAt: 0,
  elapsedSec: 0,
  level: 0,
};

let state: RecorderState = { ...idleState };
const listeners = new Set<() => void>();

let mediaRecorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let audioCtx: AudioContext | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let accumulatedSec = 0; // completed run time before the current segment
let segmentStart = 0;

function notify() {
  for (const l of listeners) l();
}

function set(patch: Partial<RecorderState>) {
  state = { ...state, ...patch };
  notify();
}

function cleanupHardware() {
  if (levelTimer) clearInterval(levelTimer);
  if (tickTimer) clearInterval(tickTimer);
  levelTimer = null;
  tickTimer = null;
  void audioCtx?.close().catch(() => {});
  audioCtx = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  mediaRecorder = null;
}

function currentElapsed(): number {
  const active = state.status === "recording" ? (Date.now() - segmentStart) / 1000 : 0;
  return Math.floor(accumulatedSec + active);
}

export const recorder = {
  getState: (): RecorderState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  async start(opts: { meetingId: string; title: string; meetingType: string }) {
    if (state.status !== "idle") throw new Error("Already recording");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    chunks = [];
    accumulatedSec = 0;
    segmentStart = Date.now();
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.start(1000);

    // Level meter
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    levelTimer = setInterval(() => {
      if (state.status !== "recording") return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / buf.length);
      set({ level: Math.min(1, rms * 3.5) });
    }, 120);
    tickTimer = setInterval(() => set({ elapsedSec: currentElapsed() }), 1000);

    set({
      status: "recording",
      meetingId: opts.meetingId,
      title: opts.title,
      meetingType: opts.meetingType,
      startedAt: Date.now(),
      elapsedSec: 0,
      level: 0,
    });
  },

  pause() {
    if (state.status !== "recording" || !mediaRecorder) return;
    mediaRecorder.pause();
    accumulatedSec += (Date.now() - segmentStart) / 1000;
    set({ status: "paused", level: 0 });
  },

  resume() {
    if (state.status !== "paused" || !mediaRecorder) return;
    mediaRecorder.resume();
    segmentStart = Date.now();
    set({ status: "recording" });
  },

  /** Stop and return the assembled audio + duration. */
  async stop(): Promise<{ blob: Blob; durationSec: number; meetingId: string; meetingType: string }> {
    const rec = mediaRecorder;
    if (!rec || state.status === "idle" || !state.meetingId) {
      throw new Error("Not recording");
    }
    const durationSec = currentElapsed();
    const meetingId = state.meetingId;
    const meetingType = state.meetingType;
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    chunks = [];
    cleanupHardware();
    set({ ...idleState });
    return { blob, durationSec, meetingId, meetingType };
  },

  /** Discard the recording entirely. */
  cancel(): string | null {
    const meetingId = state.meetingId;
    try {
      mediaRecorder?.stop();
    } catch {
      /* already stopped */
    }
    chunks = [];
    cleanupHardware();
    set({ ...idleState });
    return meetingId;
  },
};
