// WHAT: the Convex backend process lifecycle (spawn, wait until healthy, stop), free of
// Electron so tests/ can drive it with a real child process.
import { spawn } from "node:child_process";

const STOP_GRACE_MS = 5000;

/**
 * Spawn the backend. Returns its state: `child` (null once it has exited or failed to
 * spawn), `exitInfo` ({code, signal} after exit).
 */
export function spawnBackend(bin, args, { cwd, log, output }) {
  const backend = { child: null, exitInfo: null };
  const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  backend.child = proc;

  proc.stdout.on("data", output);
  proc.stderr.on("data", output);
  proc.on("exit", (code, signal) => {
    log(`Backend process exited (code ${code}, signal ${signal}).`);
    backend.exitInfo = { code, signal };
    backend.child = null;
  });
  return backend;
}

/** Poll `isHealthy` until it's true or the deadline passes. Throws on failure or timeout. */
export async function waitHealthy(backend, { isHealthy, logPath, deadlineMs = 30000, intervalMs = 400 }) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isHealthy()) return;
    if (backend.exitInfo) {
      throw new Error(`Convex backend exited early (code ${backend.exitInfo.code}). See ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Convex backend did not become healthy within ${deadlineMs}ms. See ${logPath}`);
}

/** SIGTERM, then SIGKILL after a grace period. Returns at once if there is no live child. */
export async function stopBackendProcess(backend, log) {
  const proc = backend.child;
  if (!proc) return;
  log("Stopping backend (SIGTERM)…");
  // WHY this is safe on Windows too: Node maps POSIX signals to
  // TerminateProcess there, so this is effectively an ungraceful kill (no
  // signal handler runs, unlike SIGTERM on POSIX). The data dir is WAL-mode
  // SQLite, so crash recovery on next open is the safety contract — the
  // Windows path is power-cut-equivalent, and committed transactions are
  // durable either way.
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
    }, STOP_GRACE_MS);
    proc.on("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
  backend.child = null;
}

/** Synchronous best-effort kill for process-exit / crash paths. */
export function killBackendProcessSync(backend) {
  try {
    backend.child?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}
