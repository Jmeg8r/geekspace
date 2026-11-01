// WHAT: types for the mic segment writer, so tests/ can import it.

export const MAX_CHUNK_BYTES: number;
export const MAX_SEGMENT_BYTES: number;
export const MAX_WAITING_BYTES: number;
export const CLASSIFY_STALL_MS: number;

export type MicSegmentRow = { day: string; kind: "mic"; path: string; start: number; end: number };

/**
 * `empty`: a segment ended with no audio. `dropped`: it ended after one of its chunks was
 * refused or lost. Either way it has no file and no row.
 */
export type Handled = { ok: true; empty?: boolean; dropped?: boolean } | { ok: false; reason: string };

/** A message as it arrives from the capture window: anything, until handle() has checked it. */
export type IncomingMessage = object | string | number | boolean | null | undefined;

export type MicSegmentWriter = {
  handle: (message: IncomingMessage) => Handled;
  drain: () => Promise<void>;
  close: () => Promise<void>;
  /** A call or a never-record app: drop what waits and the open segments, and write nothing more. */
  discardOpen: () => void;
  /** gs-capture has classified everything before `through`: write and finish up to it. */
  classified: (through: number) => void;
  /** Resolves once nothing waits for classification. */
  settled: () => Promise<void>;
};

export function createMicSegmentWriter(options: {
  root: string;
  addSegment: (row: MicSegmentRow) => Promise<void>;
  log: (message: string) => void;
  maxChunkBytes?: number;
  maxSegmentBytes?: number;
  /** The clock a segment's start is checked against. */
  now?: () => number;
  /** fs.writeSync, replaceable so tests can make writes short. */
  writeSync?: (fd: number, buf: Uint8Array, offset: number, length: number) => number;
  /** Hold chunks in memory until classified (the Day Recorder); off by default. */
  waitForClassification?: boolean;
  /** At most this much audio waits for classification. */
  maxWaitingBytes?: number;
  /** At most this long with audio waiting and no classification. */
  classifyStallMs?: number;
  /** fs.rmSync, replaceable so tests can make removal fail. */
  rmSync?: (path: string, options: { force: boolean }) => void;
  /** A write that fails while catching up, outside any message. */
  onError?: (reason: string) => void;
}): MicSegmentWriter;
