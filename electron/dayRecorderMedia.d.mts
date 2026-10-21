// WHAT: types for the Day Recorder media root and purge, so tests/ can import it.

export const RETENTION_DAYS: number;

export function localDay(ms: number): string;
export function ensureMediaRoot(root: string): string;
export function resolveMediaPath(root: string, rel: string): string;

/** dayRecorder.expiredMedia's result. Ids are Convex ids; plain strings here. */
export type ExpiredMedia = {
  segments: { _id: string; path: string }[];
  screenshots: { _id: string; path: string }[];
};
/** dayRecorder.markPurged's arguments. */
export type PurgeMarks = { segmentIds: string[]; screenshotIds: string[]; at: number };

export type PurgeTotals = {
  deleted: number;
  missing: number;
  refused: number;
  failed: number;
  sweptDays: number;
};

export function purgeExpired(options: {
  root: string;
  now: number;
  listExpired: (now: number) => Promise<ExpiredMedia>;
  markPurged: (marks: PurgeMarks) => Promise<void>;
  log: (message: string) => void;
}): Promise<PurgeTotals>;
