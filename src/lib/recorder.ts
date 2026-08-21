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
  deviceLabel: string; // the input actually opened, not the one requested
  silentSec: number; // consecutive seconds below SILENCE_LEVEL
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

const LEVEL_INTERVAL_MS = 120;

// WHY this floor: a dead input device (Bluetooth speakers selected as the
// system input, an unplugged interface) reports exactly 0.0 RMS. Real hardware
// always emits self-noise and room tone well above this, so the threshold
// separates "nobody is talking" from "nothing is connected".
const SILENCE_LEVEL = 0.005;

// WHY 25s: long enough that a genuine pause in a meeting never nags, short
// enough that a dead device is caught in the first minute instead of the 43rd.
export const SILENCE_WARN_SEC = 25;

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
};

const idleState: RecorderState = {
  status: "idle",
  meetingId: null,
  title: "",
  meetingType: "general",
  startedAt: 0,
  elapsedSec: 0,
  level: 0,
  deviceLabel: "",
  silentSec: 0,
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
// WHY a timestamp and not a tick counter: browsers throttle setInterval to ~1Hz
// in background/occluded windows, so accumulating a fixed 120ms per tick
// undercounts by ~8x exactly when it matters most — a minimized window during
// a long meeting. Wall-clock elapsed time is immune to throttling.
let lastSignalAt = 0;

/**
 * List available microphones. Device labels stay blank until the page has been
 * granted mic access, so open (and immediately close) a probe stream when they
 * come back empty — otherwise the picker shows a list of anonymous entries.
 */
export async function listMicrophones(): Promise<MicDevice[]> {
  const read = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  let devices = await read();
  if (devices.length > 0 && devices.every((d) => !d.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
    devices = await read();
  }
  return devices.map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `Microphone ${i + 1}`,
  }));
}

/**
 * Resolve a picker selection into the device to record with and persist.
 *
 * Empty strings are the canonical "use the system default" value: they are what
 * gets saved when the user explicitly picks System default, so the next meeting
 * reads "nothing saved" instead of silently restoring a previous device the user
 * deselected. Callers pass `deviceId || undefined` to openStream.
 */
export function resolveMicChoice(micId: string, mics: MicDevice[]) {
  const chosen = mics.find((m) => m.deviceId === micId);
  return { deviceId: chosen?.deviceId ?? "", label: chosen?.label ?? "" };
}

/**
 * Open the mic, preferring a saved device. That device can vanish between
 * meetings (unplugged, Bluetooth dropped), so fall back to the system default
 * rather than failing the recording outright.
 *
 * Exported because this is the device-resolution policy, not a helper: the
 * fallback must not swallow a permission denial, which is worth a test.
 */
export async function openStream(deviceId?: string): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } },
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
}

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
  lastSignalAt = 0;
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

  async start(opts: {
    meetingId: string;
    title: string;
    meetingType: string;
    deviceId?: string;
  }) {
    if (state.status !== "idle") throw new Error("Already recording");
    stream = await openStream(opts.deviceId);
    chunks = [];
    accumulatedSec = 0;
    segmentStart = Date.now();
    lastSignalAt = Date.now();
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
      const level = Math.min(1, rms * 3.5);
      // WHY track this: the level was already computed for the meter and then
      // discarded — it is the only in-flight evidence that the chosen input is
      // dead, and surfacing it turns a lost meeting into a 25-second warning.
      if (level > SILENCE_LEVEL) lastSignalAt = Date.now();
      set({ level, silentSec: Math.floor((Date.now() - lastSignalAt) / 1000) });
    }, LEVEL_INTERVAL_MS);
    tickTimer = setInterval(() => set({ elapsedSec: currentElapsed() }), 1000);

    set({
      status: "recording",
      meetingId: opts.meetingId,
      title: opts.title,
      meetingType: opts.meetingType,
      startedAt: Date.now(),
      elapsedSec: 0,
      level: 0,
      deviceLabel: stream.getAudioTracks()[0]?.label || "System default",
      silentSec: 0,
    });
  },

  pause() {
    if (state.status !== "recording" || !mediaRecorder) return;
    mediaRecorder.pause();
    accumulatedSec += (Date.now() - segmentStart) / 1000;
    lastSignalAt = Date.now();
    set({ status: "paused", level: 0, silentSec: 0 });
  },

  resume() {
    if (state.status !== "paused" || !mediaRecorder) return;
    mediaRecorder.resume();
    segmentStart = Date.now();
    // WHY reset: a pause is a deliberate gap, so the silence clock restarts
    // rather than firing a stale warning the instant recording resumes.
    lastSignalAt = Date.now();
    set({ status: "recording", silentSec: 0 });
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
