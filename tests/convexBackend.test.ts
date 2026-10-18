import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// WHAT: a backend binary that fails to spawn (EACCES here) makes startOrAttach() reject
// fast with the error code, never an uncaught exception, never the instance secret.
// See docs/changes/2026-10-17-backend-spawn-error/.

const { appData } = vi.hoisted(() => {
  // WHY hoisted: convexBackend.mjs computes DATA_DIR from app.getPath at import time.
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const nodePath = require("node:path") as typeof import("node:path");
  return { appData: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "gs-backend-test-")) };
});

vi.mock("electron", () => ({
  app: { getPath: () => appData, isPackaged: false },
}));

const SECRET = "dummy-instance-secret-for-tests";
const FAST_FAIL_MS = 5000;
const STOP_MS = 1000;

const dataDir = path.join(appData, "Geekspace", "convex");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ deploymentName: "test", instanceSecret: SECRET, adminKey: "test-admin" })
);
const fakeBinary = path.join(appData, "fake-backend");
fs.writeFileSync(fakeBinary, "not a binary");
fs.chmodSync(fakeBinary, 0o644);

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(appData, { recursive: true, force: true });
});

// WHY skipped on Windows: file mode doesn't stop execution there, so 0644 can't force EACCES.
describe.skipIf(process.platform === "win32")("convexBackend spawn failure", () => {
  it("rejects fast with the code, no uncaught exception, no secret; stop returns at once", async () => {
    // Nothing healthy on :3210, even if a dev `convex dev` is running on this machine.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no backend")));
    vi.stubEnv("GEEKSPACE_CONVEX_BINARY", fakeBinary);
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      const backend = await import("../electron/convexBackend.mjs");
      const outcome = await Promise.race([
        backend.startOrAttach().then(
          () => "resolved",
          (err: Error) => err.message
        ),
        new Promise<string>((r) => setTimeout(() => r("still waiting"), FAST_FAIL_MS)),
      ]);

      expect(outcome).toMatch(/failed to start: EACCES/);
      expect(outcome).not.toContain(SECRET);
      expect(uncaught).toEqual([]);

      const start = Date.now();
      await backend.stopBackend();
      expect(Date.now() - start).toBeLessThan(STOP_MS);
      expect(() => backend.killBackendSync()).not.toThrow();

      const log = fs.readFileSync(backend.getLogPath(), "utf8");
      expect(log).toMatch(/failed to start: EACCES/);
      expect(log).not.toContain(SECRET);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  }, FAST_FAIL_MS * 2);
});
