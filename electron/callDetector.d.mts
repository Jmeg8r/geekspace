// WHAT: types for call detection and the room-mic pause, so tests/ can import them.

export const CALL_APPS: Set<string>;

export type AudioUse = { app: string | null; denylisted: boolean; input: boolean; output: boolean };

export type CallDetector = {
  receive: (use: AudioUse) => void;
  /** A new helper is starting; its first report says what is still going on. */
  beginSnapshot: () => void;
  /** The first report is in: apps it did not mention have stopped. */
  endSnapshot: () => void;
};

export function createCallDetector(options: {
  onCall: (call: { active: true; app: string } | { active: false; app: null }) => void;
  onDenylistedAudio: (active: boolean) => void;
}): CallDetector;
