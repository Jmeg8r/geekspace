// WHAT: Owns the local Convex backend's lifecycle from inside Electron — the job
// `npx convex dev` used to do, minus the dev/watch machinery. Starts the
// convex-local-backend binary against a per-user data dir, waits until it's
// healthy, and stops it cleanly on quit.
// WHY: This is what turns Geekspace from "an app + a terminal babysitting a
// database in a repo" into a self-contained app you double-click. The renderer
// talks to http://127.0.0.1:3210 (baked at build time by Vite); our job is to
// make sure something is actually listening there before the window opens.
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killBackendProcessSync, spawnBackend, stopBackendProcess, waitHealthy } from "./backendProcess.mjs";
import { BACKEND_VERSION, backendCachePath } from "./backendVersion.mjs";
import { seedDataDirectory } from "./dataDirectory.mjs";
import { syncFunctions } from "./functionSync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WHY: Windows executables carry the .exe suffix; the bundled resource keeps
// the name prebake copied it under (see package.json extraResources).
const EXE = process.platform === "win32" ? ".exe" : "";

// WHY constants, not config: the renderer's Convex URL is compiled into dist/ at
// build time (VITE_CONVEX_URL), so the backend MUST listen on this exact port.
// The contract is fixed; we don't read it from config.json (which happens to
// agree) so a stale config can never silently break the renderer.
const CLOUD_PORT = 3210;
const SITE_PORT = 3211;
const CONVEX_URL = `http://127.0.0.1:${CLOUD_PORT}`;
const HEALTH_URL = `${CONVEX_URL}/version`;

// --- paths (dev vs packaged) ---------------------------------------------

// Per-user data lives outside the bundle so app updates never touch it.
// Deterministic "Geekspace" subdir (not app.getName()) so dev and packaged
// agree regardless of how Electron names the dev process.
const DATA_DIR = path.join(app.getPath("appData"), "Geekspace", "convex");
const LOG_DIR = path.join(app.getPath("appData"), "Geekspace", "logs");

function binaryPath() {
  // WHY env override first: makes future CLI cache-location drift (or a
  // manually-placed binary) a non-event — set GEEKSPACE_CONVEX_BINARY and it
  // wins over both the packaged and dev-cache lookups below.
  const override = process.env.GEEKSPACE_CONVEX_BINARY;
  if (override && fs.existsSync(override)) return override;

  if (app.isPackaged) {
    return path.join(process.resourcesPath, "convex-local-backend" + EXE);
  }
  // Dev: the pinned binary in the convex CLI cache (`npm run fetch-backend`).
  return backendCachePath();
}

function functionsBundleDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "convex-functions");
  }
  // Dev: whatever the last `npm run prebake` built (absent until then; sync is skipped).
  return path.join(__dirname, "..", "build", "convex-functions");
}

function seedDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "convex-seed");
  }
  // Dev: the repo's own local deployment is the "factory" data.
  return path.join(__dirname, "..", ".convex", "local", "default");
}

// --- module state --------------------------------------------------------

let backend = null; // spawnBackend's state for the process we started, or null if we attached
let managed = false; // true only when WE started the backend (so we own stopping it)
let logStream = null;
let functionSync = null; // syncFunctions' result for this launch, or null when attached

// --- health --------------------------------------------------------------

/** One health probe. Resolves true on HTTP 200 from /version, false otherwise. */
async function isHealthy(timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(HEALTH_URL, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function logPath() {
  return path.join(LOG_DIR, "convex.log");
}

// --- data dir ------------------------------------------------------------

/** Read the deployment config written alongside the data (instance + admin key). */
function readConfig() {
  const cfgPath = path.join(DATA_DIR, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.instanceSecret || !cfg.deploymentName) {
    throw new Error(`Malformed Convex config at ${cfgPath}`);
  }
  return cfg;
}

/**
 * Ensure DATA_DIR exists. On a fresh install it won't, so we copy the bundled
 * seed (functions already deployed + template data) into place. Existing data
 * (including a one-time migration of the user's real workspace) is never
 * overwritten.
 */
function ensureDataDir() {
  const src = seedDir();
  if (seedDataDirectory(src, DATA_DIR)) log(`Seeded fresh data dir from ${src}`);
}

// --- start / stop --------------------------------------------------------

function log(msg) {
  const line = `[convexBackend] ${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    logStream?.write(line + "\n");
  } catch {
    /* logging must never throw */
  }
}

/**
 * Make sure a healthy Convex backend is listening on :3210.
 * - If one is already up (dev: `convex dev` owns it), attach and do nothing.
 * - Otherwise (packaged, or dev with no backend), spawn the bundled binary
 *   against the per-user data dir and wait until it's healthy.
 */
export async function startOrAttach() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(logPath(), { flags: "a" });

  if (await isHealthy()) {
    managed = false;
    log("Attached to an already-running Convex backend on :3210.");
    return;
  }

  ensureDataDir();
  const cfg = readConfig();

  // Guard: the SQLite schema is tied to the binary version. If a future build
  // bumps the binary but the user's data was created by an older one, surface a
  // clear failure instead of a cryptic crash. (Same version today — this is
  // future-proofing.)
  if (cfg.backendVersion && cfg.backendVersion !== BACKEND_VERSION) {
    log(
      `WARNING: data dir backendVersion ${cfg.backendVersion} != bundled ${BACKEND_VERSION}.`
    );
  }

  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    throw new Error(`Convex backend binary not found at ${bin}`);
  }

  const args = [
    "--port", String(CLOUD_PORT),
    "--site-proxy-port", String(SITE_PORT),
    "--instance-name", cfg.deploymentName,
    "--instance-secret", cfg.instanceSecret,
    "--interface", "127.0.0.1", // single-user, never expose on the network
    "--disable-beacon", // no phone-home for a local personal app
    "--local-storage", path.join(DATA_DIR, "convex_local_storage"),
    path.join(DATA_DIR, "convex_local_backend.sqlite3"),
  ];

  log(`Starting backend: ${bin} (cwd ${DATA_DIR})`);
  backend = spawnBackend(bin, args, { cwd: DATA_DIR, log, output: (d) => logStream?.write(d) });
  managed = true;

  await waitHealthy(backend, { isHealthy, logPath: logPath() });
  log("Backend healthy on :3210.");

  // Only for a backend we started: when attached, `convex dev` owns the functions.
  functionSync = await syncFunctions({
    dataDir: DATA_DIR,
    bundleDir: functionsBundleDir(),
    url: CONVEX_URL,
    adminKey: cfg.adminKey,
    log,
    requireBundle: app.isPackaged,
    // A deliberate dev act only: there is no UI for it (see the downgrade dialog in main.mjs).
    allowDowngrade: process.env.GEEKSPACE_ALLOW_FUNCTION_DOWNGRADE === "1",
  });
}

/** Stop the backend if (and only if) we started it. Safe to call repeatedly. */
export async function stopBackend() {
  if (!managed || !backend) return;
  await stopBackendProcess(backend, log);
  managed = false;
}

/** Synchronous best-effort kill for process-exit / crash paths. */
export function killBackendSync() {
  if (managed && backend) killBackendProcessSync(backend);
}

// --- accessors -----------------------------------------------------------

export function getUrl() {
  return CONVEX_URL;
}

export function isManaged() {
  return managed;
}

/** This launch's function sync outcome (see functionSync.mjs), or null when attached. */
export function getFunctionSyncResult() {
  return functionSync;
}

export function getLogPath() {
  return logPath();
}
