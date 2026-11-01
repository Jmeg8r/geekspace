// WHAT: types for call detection and the room-mic pause, so tests/ can import them.

export const CALL_APPS: Set<string>;

export type AudioUse = { app: string | null; denylisted: boolean; input: boolean; output: boolean };

export type CallDetector = {
  receive: (use: AudioUse) => void;
  reset: () => void;
};

export function createCallDetector(options: {
  onCall: (call: { active: true; app: string } | { active: false; app: null }) => void;
  onDenylistedAudio: (active: boolean) => void;
}): CallDetector;
