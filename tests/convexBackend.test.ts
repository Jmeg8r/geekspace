import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  killBackendProcessSync,
  spawnBackend,
  stopBackendProcess,
  waitHealthy,
} from "../electron/backendProcess.mjs";

// WHAT: the backend process lifecycle convexBackend.mjs drives, run against real child
// processes. A binary that fails to spawn must reject fast with its error code, never as an
// uncaught exception, never with the instance secret. See docs/changes/2026-10-17-backend-spawn-error/.

const SECRET = "dummy-instance-secret-for-tests";
const FAST_MS = 5000;
const STOP_MS = 1000;
const LOG_PATH = "/logs/convex.log";
const never = async () => false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gs-backend-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function start(bin: string, args: string[]) {
  const lines: string[] = [];
  const backend = spawnBackend(bin, args, { cwd: tmp, log: (msg) => lines.push(msg), output: () => {} });
  return { backend, lines };
}

/** Settles `waitHealthy` to its error message, "healthy", or "still waiting" after FAST_MS. */
function outcome(promise: Promise<void>) {
  return Promise.race([
    promise.then(
      () => "healthy",
      (err: Error) => err.message
    ),
    new Promise<string>((r) => setTimeout(() => r("still waiting"), FAST_MS)),
  ]);
}

// WHY skipped on Windows: file mode doesn't stop execution there, so 0644 can't force EACCES.
describe.skipIf(process.platform === "win32")("a backend binary that fails to spawn", () => {
  it("rejects fast with the code, raises no uncaught exception, and leaks no secret", async () => {
    const bin = path.join(tmp, "fake-backend");
    fs.writeFileSync(bin, "not a binary");
    fs.chmodSync(bin, 0o644);
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const { backend, lines } = start(bin, ["--instance-secret", SECRET]);
      const message = await outcome(waitHealthy(backend, { isHealthy: never, logPath: LOG_PATH }));

      expect(message).toBe(`Convex backend failed to start: EACCES. See ${LOG_PATH}`);
      expect(uncaught).toEqual([]);
      expect(lines).toContain("Backend failed to start: EACCES");
      expect(lines.join("\n")).not.toContain(SECRET);

      const t = Date.now();
      await stopBackendProcess(backend, () => {});
      expect(Date.now() - t).toBeLessThan(STOP_MS);
      expect(() => killBackendProcessSync(backend)).not.toThrow();
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  }, FAST_MS * 2);
});

describe("a backend that spawns", () => {
  it("resolves once healthy, and stops on SIGTERM", async () => {
    const { backend } = start(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    let probes = 0;
    const healthySecondTime = async () => ++probes >= 2;
    expect(await outcome(waitHealthy(backend, { isHealthy: healthySecondTime, logPath: LOG_PATH, intervalMs: 10 }))).toBe(
      "healthy"
    );

    const proc = backend.child;
    await stopBackendProcess(backend, () => {});
    expect(backend.child).toBeNull();
    expect(proc?.exitCode !== null || proc?.signalCode !== null).toBe(true);
  });

  it("reports an early exit with its code", async () => {
    const { backend } = start(process.execPath, ["-e", "process.exit(3)"]);
    expect(await outcome(waitHealthy(backend, { isHealthy: never, logPath: LOG_PATH, intervalMs: 10 }))).toBe(
      `Convex backend exited early (code 3). See ${LOG_PATH}`
    );
  });
});
