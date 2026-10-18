// WHAT: Bring an existing data dir's Convex functions up to the ones this build ships, by
// replaying a deploy payload baked at build time through the backend's own deploy API.
// WHY: the seed is copied only on first run, so without this every app update ran its new
// renderer against the functions deployed when the data dir was born (2026-10-17: a stale
// pages:get blanked the window). The payload is baked by prebake because bundling at
// runtime needs esbuild, which can't read inside the asar. No Electron import here, so
// prebake and the tests run the exact code the packaged app runs.
// Each bundle carries an ordinal (the committer time of the commit it was built from) so an
// older build refuses to replace newer functions. See docs/changes/2026-10-17-function-sync/
// and docs/changes/2026-10-17-function-sync-no-downgrade/.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REQUEST_FILE = "push-request.json";
export const MANIFEST_FILE = "manifest.json";
export const MARKER_FILE = "functions.json";

// The backend long-polls wait_for_schema for up to this long per request (the CLI's value).
const SCHEMA_POLL_MS = 10_000;
// Schema validation scans every document; a personal workspace takes seconds. Past this,
// something is wrong and the user should hear about it rather than stare at no window.
const DEFAULT_DEADLINE_MS = 120_000;
// Enough of a backend error body to diagnose from the log without dumping a whole page.
const MAX_DETAIL_CHARS = 500;
const HASH_PREFIX_CHARS = 12;

export class SyncError extends Error {
  constructor(message, { tableName } = {}) {
    super(message);
    this.name = "SyncError";
    this.tableName = tableName;
  }
}

const isOrdinal = (value) => Number.isInteger(value) && value > 0;

function requireOrdinal(ordinal) {
  if (!isOrdinal(ordinal)) throw new Error(`Build ordinal must be a positive integer, got ${JSON.stringify(ordinal)}`);
}

/** Commit-time seconds as a readable date, for logs and the downgrade dialog. */
export function describeOrdinal(ordinal) {
  return isOrdinal(ordinal) ? new Date(ordinal * 1000).toISOString() : "unknown";
}

export function hashRequest(json) {
  return crypto.createHash("sha256").update(json).digest("hex");
}

/** The CLI writes the build machine's admin key into the payload; it must never ship. */
export function stripAdminKey(request) {
  const { adminKey: _dropped, ...rest } = request;
  return rest;
}

/** Write the payload and its manifest (build time). Returns the hash. */
export function writeBundle(dir, request, { convexVersion, ordinal }) {
  if ("adminKey" in request) throw new Error("Refusing to bundle a deploy payload that holds an admin key");
  requireOrdinal(ordinal);
  const json = JSON.stringify(request);
  const hash = hashRequest(json);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REQUEST_FILE), json);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ hash, convexVersion, ordinal }, null, 2) + "\n");
  return hash;
}

/**
 * Read the shipped payload. Throws on a leaked admin key or a payload/manifest mismatch.
 * `ordinal` is null for a manifest written before ordinals existed.
 */
export function readBundle(dir) {
  const json = fs.readFileSync(path.join(dir, REQUEST_FILE), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
  const request = JSON.parse(json);
  if ("adminKey" in request) throw new Error(`Bundled functions carry an admin key; refusing to use them (${dir})`);
  const hash = hashRequest(json);
  if (manifest.hash !== hash) {
    throw new Error(`Bundled functions do not match their manifest hash (${dir})`);
  }
  return { hash, request, ordinal: isOrdinal(manifest.ordinal) ? manifest.ordinal : null };
}

/**
 * What this data dir last deployed: `{ hash, ordinal }`, either of which may be null
 * (unknown), or null when there is no readable marker at all.
 */
export function readMarker(dataDir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, MARKER_FILE), "utf8"));
    return {
      hash: typeof marker?.hash === "string" ? marker.hash : null,
      // Markers written before ordinals have none: unknown age, so any bundle may deploy.
      ordinal: isOrdinal(marker?.ordinal) ? marker.ordinal : null,
    };
  } catch (err) {
    // Missing = never synced (a data dir older than this feature). Unparseable = treat the
    // same: redeploying is idempotent, so the safe reading of "unknown" is "out of date".
    if (err.code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Temp file + rename, so a crash mid-write can't leave a marker naming the wrong build.
 * `ordinal` null records "unknown age" (a bundle from before ordinals).
 */
export function writeMarker(dataDir, { hash, ordinal }, { now = Date.now } = {}) {
  if (ordinal !== null) requireOrdinal(ordinal);
  const target = path.join(dataDir, MARKER_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ hash, ordinal, deployedAt: new Date(now()).toISOString() }, null, 2) + "\n");
  fs.renameSync(temp, target);
}

/**
 * Forget which functions this data dir runs, so the next launch redeploys whatever bundle
 * it has. For a deploy made outside this module that can't be attributed to this data dir
 * (see `npm run deploy:local`). Returns true when a marker was removed.
 */
export function invalidateMarker(dataDir) {
  try {
    fs.unlinkSync(path.join(dataDir, MARKER_FILE));
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Record a deploy made outside this module (`npm run deploy:local`): the hash is unknown,
 * so the next launch redeploys its bundle, but only if that bundle is no older than
 * `ordinal`, the age of the code that was pushed.
 */
export function recordExternalDeploy(dataDir, ordinal, options) {
  requireOrdinal(ordinal);
  writeMarker(dataDir, { hash: null, ordinal }, options);
}

async function post(fetchImpl, url, adminKey, endpoint, body, signal) {
  const res = await fetchImpl(`${url}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ ...body, adminKey }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {
      // Not JSON (a proxy page, a crash dump): the raw text is the best detail we have.
    }
    throw new SyncError(`${endpoint} failed (HTTP ${res.status}): ${detail.slice(0, MAX_DETAIL_CHARS)}`);
  }
  return JSON.parse(text);
}

/**
 * The CLI's three-step deploy: start_push stages code and schema, wait_for_schema checks
 * existing documents against the new schema, finish_push commits. Nothing is live until
 * finish_push, so stopping at any earlier failure leaves the old functions running.
 */
export async function pushFunctions({ url, adminKey, request, fetch: fetchImpl = fetch, deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now }) {
  // WHY a timer as well as the clock check below: a backend that stops answering never
  // returns to the loop, and startup waits on this before opening the window. Aborting
  // also cancels a response body still being read.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new SyncError(`Function deploy timed out after ${Math.round(deadlineMs / 1000)}s`)),
    deadlineMs
  );
  const call = (endpoint, body) => post(fetchImpl, url, adminKey, endpoint, body, deadline.signal);
  try {
    const startedAt = now();
    const startPush = await call("/api/deploy2/start_push", { ...request, dryRun: false });
    for (;;) {
      const status = await call("/api/deploy2/wait_for_schema", {
        schemaChange: startPush.schemaChange,
        timeoutMs: SCHEMA_POLL_MS,
        dryRun: false,
      });
      if (status.type === "complete") break;
      if (status.type === "failed") {
        const where = status.tableName ? ` (table "${status.tableName}")` : "";
        throw new SyncError(`Schema validation failed${where}: ${status.error}`, { tableName: status.tableName });
      }
      if (status.type === "raceDetected") throw new SyncError("Schema was overwritten by another push");
      if (status.type !== "inProgress") throw new SyncError(`Unexpected schema status: ${JSON.stringify(status).slice(0, MAX_DETAIL_CHARS)}`);
      if (now() - startedAt > deadlineMs) {
        throw new SyncError(`Schema validation timed out after ${Math.round(deadlineMs / 1000)}s`);
      }
    }
    // If the deadline cuts this one off after the backend committed, no marker is written
    // and the next launch redeploys the same payload, which is harmless.
    await call("/api/deploy2/finish_push", { startPush, dryRun: false });
  } catch (err) {
    throw deadline.signal.aborted ? deadline.signal.reason : err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is a bundle of this ordinal older than what the data dir runs? Only a live ordinal makes
 * it so: a marker of unknown age deploys, as it did before ordinals. A bundle without one
 * predates every marker that has one, so it counts as older.
 */
function isOlder(bundleOrdinal, liveOrdinal) {
  if (liveOrdinal === null) return false;
  return bundleOrdinal === null || bundleOrdinal < liveOrdinal;
}

/**
 * Deploy the bundled functions if the data dir runs anything else, unless the bundle is
 * older than what it runs ("downgrade"; `allowDowngrade` deploys anyway). Never throws:
 * the result says what happened so the caller can tell the user.
 * @returns {Promise<{status: "current"|"deployed"|"downgrade"|"skipped"|"failed", hash?: string, bundleOrdinal?: number|null, liveOrdinal?: number, error?: Error}>}
 */
export async function syncFunctions({ dataDir, bundleDir, url, adminKey, fetch: fetchImpl = fetch, log, requireBundle = false, allowDowngrade = false, deadlineMs, now = Date.now }) {
  if (!fs.existsSync(path.join(bundleDir, REQUEST_FILE))) {
    const message = `No bundled functions at ${bundleDir}`;
    if (requireBundle) {
      log(`ERROR: ${message}; this build is incomplete.`);
      return { status: "failed", error: new SyncError(message) };
    }
    log(`${message}; skipping function sync (run \`npm run prebake\` to build them).`);
    return { status: "skipped" };
  }
  if (!adminKey) {
    const message = `No admin key in ${dataDir}/config.json; can't deploy functions`;
    log(`ERROR: ${message}.`);
    return { status: "failed", error: new SyncError(message) };
  }
  let hash;
  try {
    const bundle = readBundle(bundleDir);
    hash = bundle.hash;
    const short = hash.slice(0, HASH_PREFIX_CHARS);
    const live = readMarker(dataDir);
    const bundleOrdinal = bundle.ordinal;
    const liveOrdinal = live?.ordinal ?? null;
    if (live?.hash === hash) {
      // Same functions, but this build may be newer (or the marker predates ordinals).
      // Record the newer age so a later, different bundle in between is still refused.
      // Never lowers it: an older build of identical functions says nothing new.
      if (bundleOrdinal !== null && (liveOrdinal === null || bundleOrdinal > liveOrdinal)) {
        writeMarker(dataDir, { hash, ordinal: bundleOrdinal }, { now });
        log(`Functions current (${short}); recorded them as code of ${describeOrdinal(bundleOrdinal)}.`);
      } else {
        log(`Functions current (${short}).`);
      }
      return { status: "current", hash };
    }
    if (isOlder(bundleOrdinal, liveOrdinal)) {
      const ages = `bundle built from code of ${describeOrdinal(bundleOrdinal)}, data dir runs code of ${describeOrdinal(liveOrdinal)}`;
      if (!allowDowngrade) {
        log(`WARNING: bundled functions ${short} are older than the live ones (${ages}); skipping the deploy and keeping the newer functions.`);
        return { status: "downgrade", hash, bundleOrdinal, liveOrdinal };
      }
      log(`WARNING: downgrade forced by GEEKSPACE_ALLOW_FUNCTION_DOWNGRADE (${ages}).`);
    }
    log(`Deploying bundled functions ${short}…`);
    const startedAt = now();
    await pushFunctions({ url, adminKey, request: bundle.request, fetch: fetchImpl, deadlineMs, now });
    writeMarker(dataDir, { hash, ordinal: bundleOrdinal }, { now });
    log(`Deployed functions ${short} in ${now() - startedAt}ms.`);
    return { status: "deployed", hash };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log(`ERROR: function sync failed; the previous functions are still live. ${error.message}`);
    return { status: "failed", hash, error };
  }
}
