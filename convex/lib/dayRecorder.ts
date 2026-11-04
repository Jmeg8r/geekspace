import { isDateValue, type PropertyBag, type PropertyValue } from "./rowProperties";

// WHAT: boundary checks and defaults shared by convex/dayRecorder.ts and convex/assistant.ts.
// WHY one place: these handlers are the trust boundary between the app and the database
// (repo review standard), and the same day, path and number rules apply in both.
// See docs/changes/2026-10-18-day-recorder/.

export const DAY_MS = 86_400_000;
// Spec R14: raw media is kept 30 days; derived text is kept forever.
export const RETENTION_DAYS = 30;
// Bounds the purge and the retention query; the purge job pages through bigger backlogs.
export const PURGE_BATCH = 200;

// Defaults, from the spec and the PR 1 spike (SHOT_SEC settled at 30).
export const DEFAULT_SHOT_SEC = 30;
export const DEFAULT_BATCH_MIN = 15;
const MIN_SHOT_SEC = 5;
const MAX_SHOT_SEC = 3600;
const MIN_BATCH_MIN = 1;
const MAX_BATCH_MIN = 240;
// A ceiling that catches a typo (2500 for 2.50), not a budget opinion.
const MAX_DAILY_CAP_USD = 1000;
// The longest block the assistant may book in one go: a full working day.
export const MAX_BLOCK_MS = 10 * 3_600_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_TITLE_CHARS = 500;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A file directly inside the day folder: no separators, no leading dot, so never ".." or
// a hidden file. Media paths are stored relative to the media root, so this shape is what
// keeps every later read or delete inside it.
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
// Reverse-DNS bundle id: two or more labels.
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function assertDay(day: string): void {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`Invalid day "${day}": expected YYYY-MM-DD`);
  }
}

/** A media path must be "<day>/<file>" for the record's own day. */
export function assertMediaPath(path: string, day: string): void {
  const slash = path.indexOf("/");
  const folder = path.slice(0, slash);
  const file = path.slice(slash + 1);
  if (slash < 0 || folder !== day || !FILE_RE.test(file)) {
    throw new Error(`Invalid media path "${path}": expected "${day}/<file>" inside the media root`);
  }
}

// Local time runs from UTC-12 to UTC+14, so local day D starts between D 00:00Z - 14 h and
// D 00:00Z + 12 h. The backend doesn't know the Mac's timezone, so it accepts that window.
const EARLIEST_OFFSET_MS = 14 * 3_600_000;
const LATEST_OFFSET_MS = 12 * 3_600_000;

/**
 * A row's day must be a local day its own capture time can fall on. WHY: the purge selects
 * rows by time and deletes by path, so a row whose old time pointed at a current day's file
 * would delete live media (CSO finding 4016f9d6). The purge refuses that too.
 */
export function assertCaptureDay(day: string, at: number): void {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  if (at < dayStart - EARLIEST_OFFSET_MS || at >= dayStart + DAY_MS + LATEST_OFFSET_MS) {
    throw new Error(`Day ${day} does not match its capture time ${new Date(at).toISOString()}`);
  }
}

export function assertTime(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}: ${value}`);
}

export function assertSpan(start: number, end: number): void {
  assertTime("start", start);
  assertTime("end", end);
  if (end < start) throw new Error(`Invalid span: end ${end} is before start ${start}`);
}

export function assertText(name: string, text: string, max = MAX_TEXT_CHARS): void {
  if (text.length > max) throw new Error(`${name} is too long (${text.length} > ${max} characters)`);
}

export function assertTitle(title: string): void {
  if (!title.trim()) throw new Error("Task title is empty");
  assertText("Task title", title, MAX_TITLE_CHARS);
}

export function assertBundleId(id: string): void {
  if (!BUNDLE_ID_RE.test(id)) throw new Error(`Invalid app bundle id "${id}"`);
}

export function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name}: ${value}`);
}

export function assertCost(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid cost: ${value}`);
}

export function assertShotSec(value: number): void {
  if (!Number.isInteger(value) || value < MIN_SHOT_SEC || value > MAX_SHOT_SEC) {
    throw new Error(`Screenshot interval must be ${MIN_SHOT_SEC}–${MAX_SHOT_SEC} seconds, got ${value}`);
  }
}

export function assertBatchMin(value: number): void {
  if (!Number.isInteger(value) || value < MIN_BATCH_MIN || value > MAX_BATCH_MIN) {
    throw new Error(`Assistant batch interval must be ${MIN_BATCH_MIN}–${MAX_BATCH_MIN} minutes, got ${value}`);
  }
}

export function assertDailyCap(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_DAILY_CAP_USD) {
    throw new Error(`Daily cap must be $0–$${MAX_DAILY_CAP_USD}, got ${value}`);
  }
}

const ISSUE_REF_RE = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const MAX_DRAFT_CHARS = 10_000;

export function assertIssueRef(ref: string): void {
  if (!ISSUE_REF_RE.test(ref)) throw new Error(`Invalid Linear issue reference "${ref}"`);
}

export function assertDraftBody(body: string): void {
  if (!body.trim()) throw new Error("Draft body is empty");
  assertText("Draft body", body, MAX_DRAFT_CHARS);
}

// One fixed key order for a date value, whatever order it was written in.
function canonical(value: PropertyValue): PropertyValue {
  if (value === null || Array.isArray(value) || !isDateValue(value)) return value;
  return { start: value.start, end: value.end, includeTime: value.includeTime };
}

/**
 * A row's user-visible state as a string that changes whenever the row does. Property ids
 * are sorted so the same state always gives the same string, whatever order the
 * properties were written in.
 */
export function rowFingerprint(row: { title: string; properties: PropertyBag; content?: string }): string {
  const properties = Object.keys(row.properties)
    .sort()
    .map((id) => [id, canonical(row.properties[id])]);
  return JSON.stringify([row.title, properties, row.content ?? null]);
}

/** The newest capture time that has expired at `now`. */
export function retentionCutoff(now: number): number {
  assertTime("now", now);
  return now - RETENTION_DAYS * DAY_MS;
}
