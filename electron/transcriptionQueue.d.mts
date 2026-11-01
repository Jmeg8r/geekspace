// WHAT: types for the transcription queue, so tests/ can import it.

export const RETRY_AFTER_MS: number;

/** A closed segment, as dayRecorder.pendingSegments lists it. */
export type PendingSegment = { _id: string; path: string; start: number; end: number };

export type TranscribeResult = { transcript: string } | { silent: true } | { noSpeech: true };

export type TranscriptionQueue = {
  offer: (segments: PendingSegment[]) => void;
  idle: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createTranscriptionQueue(options: {
  transcribe: (file: string) => Promise<TranscribeResult>;
  resolvePath: (mediaPath: string) => string;
  addTranscript: (row: { segmentId: string; start: number; end: number; text: string }) => Promise<void>;
  setSegmentStatus: (segmentId: string, status: "transcribed" | "failed") => Promise<void>;
  log: (message: string) => void;
}): TranscriptionQueue;
