// WHAT: entry for the hidden mic capture window (capture.html, plan PR 3d-2). Opens the
// default input, runs micCapture.ts on it, and passes every event to the main process
// through the window's own preload (electron/capturePreload.cjs).
import { openStream, rmsLevel } from "../lib/recorder";
import { micErrorKind, startMicCapture, type MicEvent, type RecorderLike } from "./micCapture";

type CaptureBridge = {
  config: () => Promise<{ ok: true; data: { segmentSec: number; timesliceMs: number } } | { ok: false; error: string }>;
  event: (event: MicEvent) => void;
  onStop: (cb: () => void) => void;
};

const COPY = {
  denied: "Microphone access is off for Geekspace. Turn it on in System Settings > Privacy & Security > Microphone.",
  noDevice: "No microphone is connected.",
  unavailable: "The microphone is in use or not responding.",
};

function bridge(): CaptureBridge | undefined {
  // SAFETY: gsCapture is optional in this type, and run() only starts when it is present;
  // electron/capturePreload.cjs is the one place that defines it, with exactly this shape.
  return (window as { gsCapture?: CaptureBridge }).gsCapture;
}

const MIME = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";

/** MediaRecorder as micCapture.ts drives it: its events forwarded to RecorderLike's handlers. */
function adapt(recorder: MediaRecorder): RecorderLike {
  const like: RecorderLike = {
    start: (timesliceMs) => recorder.start(timesliceMs),
    stop: () => recorder.stop(),
    ondataavailable: null,
    onstop: null,
    onerror: null,
  };
  recorder.ondataavailable = (e) => like.ondataavailable?.({ data: e.data });
  recorder.onstop = () => like.onstop?.();
  // The DOM types give a plain Event here; the recorder's own failure has no more detail.
  recorder.onerror = () => like.onerror?.({ error: { name: "MediaRecorderError" } });
  return like;
}

async function run(api: CaptureBridge) {
  const cfg = await api.config();
  if (!cfg.ok) {
    api.event({ type: "error", kind: "unavailable", message: cfg.error });
    api.event({ type: "stopped" });
    return;
  }
  let stream: MediaStream;
  try {
    stream = await openStream();
  } catch (err) {
    const kind = micErrorKind(err instanceof Error ? err : {});
    api.event({ type: "error", kind, message: kind === "denied" || kind === "noDevice" ? COPY[kind] : COPY.unavailable });
    api.event({ type: "stopped" });
    return;
  }
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const frame = new Uint8Array(analyser.fftSize);
  const capture = startMicCapture({
    stream,
    createRecorder: () => adapt(new MediaRecorder(stream, { mimeType: MIME })),
    segmentSec: cfg.data.segmentSec,
    timesliceMs: cfg.data.timesliceMs,
    readLevel: () => {
      analyser.getByteTimeDomainData(frame);
      return rmsLevel(frame);
    },
    emit: api.event,
  });
  api.onStop(() => {
    void capture.stop().finally(() => {
      stream.getTracks().forEach((t) => t.stop());
      void audio.close();
    });
  });
}

const api = bridge();
if (api) void run(api);
else console.error("Day Recorder mic: the capture bridge is missing; this page only runs in the capture window");
