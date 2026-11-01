// WHAT: the hidden capture window's startup (plan PR 3d-2): read the config, open the mic,
// start capture, and stop it when the main process asks. main.ts supplies the DOM parts.
// WHY the stop listener comes first (Codex #89 r1): config and getUserMedia both take time,
// and a stop that lands then must not be lost. Startup checks for it after each wait, lets go
// of a mic it opened anyway, and still says stopped, so the main process is never left waiting.
import { micErrorKind, type MicErrorKind, type MicEvent } from "./micCapture";

export type MicConfig = { segmentSec: number; timesliceMs: number };

export type CaptureBridge = {
  config: () => Promise<{ ok: true; data: MicConfig } | { ok: false; error: string }>;
  event: (event: MicEvent) => void;
  onStop: (cb: () => void) => void;
};

/** An opened input: start capture on it, or let it go (tracks and audio graph). */
export type OpenedMic = {
  start: (cfg: MicConfig) => { stop(): Promise<void> };
  release: () => void;
};

const COPY = {
  denied: "Microphone access is off for Geekspace. Turn it on in System Settings > Privacy & Security > Microphone.",
  noDevice: "No microphone is connected.",
  unavailable: "The microphone is in use or not responding.",
};

export async function runMicWindow(api: CaptureBridge, openMic: () => Promise<OpenedMic>): Promise<void> {
  let stopAsked = false;
  let mic: OpenedMic | null = null;
  let capture: { stop(): Promise<void> } | null = null;

  api.onStop(() => {
    if (stopAsked) return;
    stopAsked = true;
    // Before capture runs, startup sees the flag after its current wait and says stopped.
    if (!capture) return;
    void capture.stop().finally(() => mic?.release());
  });

  const failStartup = (kind: MicErrorKind, message: string) => {
    mic?.release();
    api.event({ type: "error", kind, message });
    api.event({ type: "stopped" });
  };
  const stoppedDuringStartup = () => {
    mic?.release();
    api.event({ type: "stopped" });
  };

  const cfg = await api.config();
  if (!cfg.ok) return failStartup("unavailable", cfg.error);
  if (stopAsked) return stoppedDuringStartup();

  try {
    mic = await openMic();
  } catch (err) {
    const kind = micErrorKind(err instanceof Error ? err : {});
    return failStartup(kind, kind === "denied" || kind === "noDevice" ? COPY[kind] : COPY.unavailable);
  }
  if (stopAsked) return stoppedDuringStartup();

  try {
    capture = mic.start(cfg.data);
  } catch (err) {
    console.error("Day Recorder mic: could not set up capture", err);
    failStartup("unavailable", COPY.unavailable);
  }
}
