// WHAT: types for call detection and the room-mic pause, so tests/ can import them.

export const CALL_APPS: Set<string>;

export type AudioUse = { app: string | null; denylisted: boolean; input: boolean; output: boolean };

export type CallDetector = {
  receive: (use: AudioUse) => void;
  /** A new helper reports every app afresh; forget the old state without announcing it. */
  reset: () => void;
};

export function createCallDetector(options: {
  /** A call app joined (each one, every time). */
  onAppStarted: (app: string) => void;
  /** The last call app stopped using audio. */
  onCallEnded: () => void;
  onDenylistedAudio: (active: boolean) => void;
}): CallDetector;
