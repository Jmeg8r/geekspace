// WHAT: entry for the hidden mic capture window (capture.html, plan PR 3d-2). Supplies the DOM
// parts (getUserMedia, MediaRecorder, the level meter) to micWindow.ts, which runs startup and
// stop, and passes every event to the main process through the window's own preload
// (electron/capturePreload.cjs).
import { openStream, rmsLevel } from "../lib/recorder";
import { startMicCapture, type RecorderLike } from "./micCapture";
import { runMicWindow, type CaptureBridge, type OpenedMic } from "./micWindow";

function bridge(): CaptureBridge | undefined {
  // SAFETY: gsCapture is optional in this type, and runMicWindow() only starts when it is present;
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

/** Open the default input; capture starts on it only when micWindow.ts says so. */
async function openMic(api: CaptureBridge): Promise<OpenedMic> {
  const stream = await openStream();
  let audio: AudioContext | null = null;
  return {
    start: (cfg) => {
      audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const frame = new Uint8Array(analyser.fftSize);
      return startMicCapture({
        stream,
        createRecorder: () => adapt(new MediaRecorder(stream, { mimeType: MIME })),
        segmentSec: cfg.segmentSec,
        timesliceMs: cfg.timesliceMs,
        readLevel: () => {
          analyser.getByteTimeDomainData(frame);
          return rmsLevel(frame);
        },
        emit: api.event,
      });
    },
    release: () => {
      stream.getTracks().forEach((t) => t.stop());
      void audio?.close();
    },
  };
}

const api = bridge();
if (api) void runMicWindow(api, () => openMic(api));
else console.error("Day Recorder mic: the capture bridge is missing; this page only runs in the capture window");
