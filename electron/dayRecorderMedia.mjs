// WHAT: the Day Recorder media root and its retention purge (spec R14, plan PR 3c).
// Convex chooses which rows are past 30 days (dayRecorder.expiredMedia); this deletes their
// files, marks them purged, then sweeps whole day folders past retention for files that
// no row names: a crash's hidden `.partial-*` segment, or a shot written but never
// announced (plan.md, PR 3b-2).
// WHY the guard: this is the only code that deletes files. Every path is resolved and must
// stay inside the media root before anything is removed (spec, Security and data).
import fs from "node:fs";
import path from "node:path";

// Must equal RETENTION_DAYS in convex/lib/dayRecorder.ts (tests/dayRecorderPurge.test.ts checks).
export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
// Pages of PURGE_BATCH rows each (convex/lib/dayRecorder.ts); a cap so one run can't spin.
const MAX_PAGES = 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// The shape convex/lib/dayRecorder.ts assertMediaPath accepts: no separators, no leading dot.
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** The local calendar day of `ms`, as the helper names its day folders. */
export function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Create the media root, readable only by this user, and return its real path. */
export function ensureMediaRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and ignored for a folder that already exists.
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

// Set on every refusal, so the purge can tell a bad path from a failed delete.
const REFUSED = "EMEDIAPATH";

function refuse(message) {
  return Object.assign(new Error(message), { code: REFUSED });
}

function outside(rel) {
  return refuse(`Refusing media path ${JSON.stringify(rel)}: it is outside the media root`);
}

/**
 * Resolve a stored `<day>/<file>` path to an absolute one inside `root` (a real path).
 * Throws for any other shape, and for a day folder that is a symlink leading out.
 */
export function resolveMediaPath(root, rel) {
  if (typeof rel !== "string" || path.isAbsolute(rel)) throw outside(rel);
  const parts = rel.split("/");
  if (parts.length !== 2 || !DAY_RE.test(parts[0]) || !FILE_RE.test(parts[1])) {
    throw refuse(`Refusing media path ${JSON.stringify(rel)}: expected "<day>/<file>"`);
  }
  const resolved = path.resolve(root, rel);
  if (path.dirname(path.dirname(resolved)) !== root) throw outside(rel);
  let folder;
  try {
    folder = fs.realpathSync(path.dirname(resolved));
  } catch (err) {
    if (err.code === "ENOENT") return resolved;
    throw err;
  }
  if (path.dirname(folder) !== root) throw outside(rel);
  return resolved;
}

function removeFile(root, rel, newestExpired) {
  const file = resolveMediaPath(root, rel);
  // WHY: Convex checks a row's day and its capture time separately, and the local backend
  // takes unauthenticated calls, so a row's old time is not trusted to vouch for its file.
  // Only a file in a day folder that is at least partly past retention can be deleted.
  if (rel.slice(0, rel.indexOf("/")) > newestExpired) {
    throw refuse(`Refusing media path ${JSON.stringify(rel)}: its day is still inside retention`);
  }
  try {
    fs.unlinkSync(file);
    return "deleted";
  } catch (err) {
    if (err.code === "ENOENT") return "missing";
    throw err;
  }
}

/** Delete day folders whose whole day is past retention. Returns how many went. */
function sweepExpiredDays(root, now, log) {
  // A folder holds one local day. It is fully expired only when the next day began at or
  // before the cutoff, so the day that straddles the cutoff waits until tomorrow.
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const newestExpired = localDay(cutoff);
  let swept = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    // Only real day folders: not the API key blob, not a symlink, not anything else.
    if (!entry.isDirectory() || !DAY_RE.test(entry.name) || entry.name >= newestExpired) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true });
      swept++;
    } catch (err) {
      log(`purge: could not remove an expired day folder (${err?.code ?? err})`);
    }
  }
  return swept;
}

/**
 * Purge media past retention. `listExpired` and `markPurged` are the Convex handlers.
 * Logs counts only, never paths (spec, Logging).
 */
export async function purgeExpired({ root, now, listExpired, markPurged, log }) {
  const totals = { deleted: 0, missing: 0, refused: 0, failed: 0, sweptDays: 0 };
  const newestExpired = localDay(now - RETENTION_DAYS * DAY_MS);
  for (let page = 0; page < MAX_PAGES; page++) {
    const { segments, screenshots } = await listExpired(now);
    if (segments.length === 0 && screenshots.length === 0) break;
    const marks = { segmentIds: [], screenshotIds: [], at: now };
    const take = (rows, ids) => {
      for (const row of rows) {
        try {
          totals[removeFile(root, row.path, newestExpired)]++;
          ids.push(row._id);
        } catch (err) {
          const refused = err?.code === REFUSED;
          totals[refused ? "refused" : "failed"]++;
          log(`purge: ${refused ? "refused" : "could not delete"} the file of row ${row._id} (${refused ? "bad path" : err?.code ?? err})`);
        }
      }
    };
    take(segments, marks.segmentIds);
    take(screenshots, marks.screenshotIds);
    // Rows that can't be deleted are served again first; stop rather than spin on them.
    if (marks.segmentIds.length === 0 && marks.screenshotIds.length === 0) break;
    await markPurged(marks);
  }
  totals.sweptDays = sweepExpiredDays(root, now, log);
  log(
    `purge: deleted ${totals.deleted}, already gone ${totals.missing}, refused ${totals.refused}, failed ${totals.failed}, swept ${totals.sweptDays} day folders`
  );
  return totals;
}
