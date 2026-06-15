// WHAT: Owns the local Convex backend's lifecycle from inside Electron — the job
// `npx convex dev` used to do, minus the dev/watch machinery. Starts the
// convex-local-backend binary against a per-user data dir, waits until it's
// healthy, and stops it cleanly on quit.
// WHY: This is what turns Geekspace from "an app + a terminal babysitting a
// database in a repo" into a self-contained app you double-click. The renderer
// talks to http://127.0.0.1:3210 (baked at build time by Vite); our job is to
// make sure something is actually listening there before the window opens.
import { app } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WHY constants, not config: the renderer's Convex URL is compiled into dist/ at
// build time (VITE_CONVEX_URL), so the backend MUST listen on this exact port.
// The contract is fixed; we don't read it from config.json (which happens to
// agree) so a stale config can never silently break the renderer.
const CLOUD_PORT = 3210;
const SITE_PORT = 3211;
const CONVEX_URL = `http://127.0.0.1:${CLOUD_PORT}`;
const HEALTH_URL = `${CONVEX_URL}/version`;

// The precompiled backend version we bundle. The on-disk SQLite schema is tied
// to the binary version, so a future bump must re-bake the seed (see the guard
// in startOrAttach). Keep in sync with the binary shipped via extraResources.
const BUNDLED_BACKEND_VERSION = "precompiled-2026-06-09-b6aaa1a";

// --- paths (dev vs packaged) ---------------------------------------------

// Per-user data lives outside the bundle so app updates never touch it.
// Deterministic "Geekspace" subdir (not app.getName()) so dev and packaged
// agree regardless of how Electron names the dev process.
const DATA_DIR = path.join(app.getPath("appData"), "Geekspace", "convex");
const LOG_DIR = path.join(app.getPath("appData"), "Geekspace", "logs");

function binaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "convex-local-backend");
  }
  // Dev: the same binary the convex CLI downloaded into its cache.
  return path.join(
    os.homedir(),
    ".cache",
    "convex",
    "binaries",
    BUNDLED_BACKEND_VERSION,
    "convex-local-backend"
  );
}

function seedDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "convex-seed");
  }
  // Dev: the repo's own local deployment is the "factory" data.
  return path.join(__dirname, "..", ".convex", "local", "default");
}

// --- module state --------------------------------------------------------

let child = null; // the spawned backend process, or null if we attached/it exited
let managed = false; // true only when WE started the backend (so we own stopping it)
let exitInfo = null; // {code, signal} once a managed backend process has exited
let logStream = null;

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

/** Poll /version until healthy or the deadline passes. Throws on timeout. */
async function waitHealthy(deadlineMs = 30000, intervalMs = 400) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isHealthy()) return;
    // If the child died while we were waiting, fail fast with its log (the exit
    // handler nulls `child`, so we read the recorded exit info, not child).
    if (managed && exitInfo) {
      throw new Error(
        `Convex backend exited early (code ${exitInfo.code}). See ${logPath()}`
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Convex backend did not become healthy within ${deadlineMs}ms. See ${logPath()}`
  );
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
  if (fs.existsSync(path.join(DATA_DIR, "config.json"))) return;
  const src = seedDir();
  if (!fs.existsSync(path.join(src, "config.json"))) {
    throw new Error(`No Convex data and no bundled seed found at ${src}`);
  }
  fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  // cpSync preserves the relative layout the SQLite blob store relies on.
  fs.cpSync(src, DATA_DIR, { recursive: true });
  log(`Seeded fresh data dir from ${src}`);
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
  if (cfg.backendVersion && cfg.backendVersion !== BUNDLED_BACKEND_VERSION) {
    log(
      `WARNING: data dir backendVersion ${cfg.backendVersion} != bundled ${BUNDLED_BACKEND_VERSION}.`
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
  exitInfo = null;
  child = spawn(bin, args, { cwd: DATA_DIR, stdio: ["ignore", "pipe", "pipe"] });
  managed = true;

  child.stdout.on("data", (d) => logStream?.write(d));
  child.stderr.on("data", (d) => logStream?.write(d));
  child.on("exit", (code, signal) => {
    log(`Backend process exited (code ${code}, signal ${signal}).`);
    exitInfo = { code, signal };
    child = null;
  });

  await waitHealthy();
  log("Backend healthy on :3210.");
}

/** Stop the backend if (and only if) we started it. Safe to call repeatedly. */
export async function stopBackend() {
  if (!managed || !child) return;
  const proc = child;
  log("Stopping backend (SIGTERM)…");
  proc.kill("SIGTERM");

  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      log("Backend did not exit in time — SIGKILL.");
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 5000);
    proc.on("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });

  child = null;
  managed = false;
}

/** Synchronous best-effort kill for process-exit / crash paths. */
export function killBackendSync() {
  if (managed && child) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// --- accessors -----------------------------------------------------------

export function getUrl() {
  return CONVEX_URL;
}

export function isManaged() {
  return managed;
}
