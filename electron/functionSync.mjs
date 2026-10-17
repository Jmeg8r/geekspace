// WHAT: Bring an existing data dir's Convex functions up to the ones this build ships, by
// replaying a deploy payload baked at build time through the backend's own deploy API.
// WHY: the seed is copied only on first run, so without this every app update ran its new
// renderer against the functions deployed when the data dir was born (2026-10-17: a stale
// pages:get blanked the window). The payload is baked by prebake because bundling at
// runtime needs esbuild, which can't read inside the asar. No Electron import here, so
// prebake and the tests run the exact code the packaged app runs.
// See docs/changes/2026-10-17-function-sync/.
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

export function hashRequest(json) {
  return crypto.createHash("sha256").update(json).digest("hex");
}

/** The CLI writes the build machine's admin key into the payload; it must never ship. */
export function stripAdminKey(request) {
  const { adminKey: _dropped, ...rest } = request;
  return rest;
}

/** Write the payload and its manifest (build time). Returns the hash. */
export function writeBundle(dir, request, { convexVersion }) {
  if ("adminKey" in request) throw new Error("Refusing to bundle a deploy payload that holds an admin key");
  const json = JSON.stringify(request);
  const hash = hashRequest(json);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REQUEST_FILE), json);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ hash, convexVersion }, null, 2) + "\n");
  return hash;
}

/** Read the shipped payload. Throws on a leaked admin key or a payload/manifest mismatch. */
export function readBundle(dir) {
  const json = fs.readFileSync(path.join(dir, REQUEST_FILE), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
  const request = JSON.parse(json);
  if ("adminKey" in request) throw new Error(`Bundled functions carry an admin key; refusing to use them (${dir})`);
  const hash = hashRequest(json);
  if (manifest.hash !== hash) {
    throw new Error(`Bundled functions do not match their manifest hash (${dir})`);
  }
  return { hash, request };
}

/** The hash of the functions this data dir last deployed, or null if unknown. */
export function readMarker(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, MARKER_FILE), "utf8")).hash ?? null;
  } catch (err) {
    // Missing = never synced (a data dir older than this feature). Unparseable = treat the
    // same: redeploying is idempotent, so the safe reading of "unknown" is "out of date".
    if (err.code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

/** Temp file + rename, so a crash mid-write can't leave a marker naming the wrong build. */
export function writeMarker(dataDir, hash, { now = Date.now } = {}) {
  const target = path.join(dataDir, MARKER_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ hash, deployedAt: new Date(now()).toISOString() }, null, 2) + "\n");
  fs.renameSync(temp, target);
}

async function post(fetchImpl, url, adminKey, endpoint, body) {
  const res = await fetchImpl(`${url}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Convex ${adminKey}` },
    body: JSON.stringify({ ...body, adminKey }),
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
  const startedAt = now();
  const startPush = await post(fetchImpl, url, adminKey, "/api/deploy2/start_push", { ...request, dryRun: false });
  for (;;) {
    const status = await post(fetchImpl, url, adminKey, "/api/deploy2/wait_for_schema", {
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
  await post(fetchImpl, url, adminKey, "/api/deploy2/finish_push", { startPush, dryRun: false });
}

/**
 * Deploy the bundled functions if the data dir runs anything else. Never throws: the
 * result says what happened so the caller can tell the user.
 * @returns {Promise<{status: "current"|"deployed"|"skipped"|"failed", hash?: string, error?: Error}>}
 */
export async function syncFunctions({ dataDir, bundleDir, url, adminKey, fetch: fetchImpl = fetch, log, requireBundle = false, deadlineMs, now = Date.now }) {
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
    if (readMarker(dataDir) === hash) {
      log(`Functions current (${short}).`);
      return { status: "current", hash };
    }
    log(`Deploying bundled functions ${short}…`);
    const startedAt = now();
    await pushFunctions({ url, adminKey, request: bundle.request, fetch: fetchImpl, deadlineMs, now });
    writeMarker(dataDir, hash, { now });
    log(`Deployed functions ${short} in ${now() - startedAt}ms.`);
    return { status: "deployed", hash };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log(`ERROR: function sync failed; the previous functions are still live. ${error.message}`);
    return { status: "failed", hash, error };
  }
}
