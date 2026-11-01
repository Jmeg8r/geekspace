// WHAT: types for the mic segment writer, so tests/ can import it.

export const MAX_CHUNK_BYTES: number;
export const MAX_SEGMENT_BYTES: number;

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
}): MicSegmentWriter;
