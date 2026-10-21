// WHAT: builds the Day Recorder service with its real parts for main.mjs (plan PR 3c): the
// bundled gs-capture, the media root under app data, the start gates, a main-process Convex
// client, and a log file next to the backend's.
// WHY a main-process client: capture runs whether or not a window is open, so the rows for
// what the helper writes can't depend on the renderer. Settings arrive by subscription, so
// turning the recorder on, or editing the denylist, reaches the helper without IPC (the
// renderer's controls come in PR 3d/3e).
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { ConvexClient } from "convex/browser";
// The generated `api` is exactly `anyApi` (convex/_generated/api.js), and convex/ is not
// packaged into the app, so the main process uses anyApi directly.
import { anyApi as api } from "convex/server";
import { createSupervisor } from "./dayRecorder.mjs";
import { checkFileVault, ensureBackupExclusion } from "./dayRecorderGates.mjs";
import { ensureMediaRoot, purgeExpired } from "./dayRecorderMedia.mjs";
import { createDayRecorderService } from "./dayRecorderService.mjs";

const GEEKSPACE_DIR = path.join(app.getPath("appData"), "Geekspace");

function helperPath() {
  // Packaged: Contents/Resources/gs-capture (package.json mac.extraResources).
  // Dev: what `npm run build:gs-capture` builds.
  return app.isPackaged
    ? path.join(process.resourcesPath, "gs-capture")
    : path.join(app.getAppPath(), "native", "gs-capture", ".build", "release", "gs-capture");
}

/** Start following the Day Recorder settings. Returns a handle main.mjs stops on quit. */
export function startDayRecorder({ convexUrl }) {
  const logDir = path.join(GEEKSPACE_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, "day-recorder.log"), { flags: "a" });
  const log = (message) => logStream.write(`${new Date().toISOString()} ${message}\n`);

  const client = new ConvexClient(convexUrl);
  const mediaDir = path.join(GEEKSPACE_DIR, "day-recorder");
  // Off macOS the service never starts a helper, so it never needs the folder either.
  const mediaRoot = process.platform === "darwin" ? ensureMediaRoot(mediaDir) : mediaDir;
  const rows = (fn) => async (args) => {
    await client.mutation(fn, args);
  };

  const service = createDayRecorderService({
    platform: process.platform,
    mediaRoot,
    helperPath: helperPath(),
    gates: { fileVault: () => checkFileVault(), backupExclusion: (root) => ensureBackupExclusion(root) },
    createSupervisor,
    convex: {
      addScreenshot: rows(api.dayRecorder.addScreenshot),
      addSegment: rows(api.dayRecorder.addSegment),
      logEvent: (event) => rows(api.dayRecorder.logEvent)({ at: Date.now(), ...event }),
    },
    purge: async () => {
      await purgeExpired({
        root: mediaRoot,
        now: Date.now(),
        listExpired: (now) => client.query(api.dayRecorder.expiredMedia, { now }),
        markPurged: rows(api.dayRecorder.markPurged),
        log,
      });
    },
    log,
  });
  service.onStatus((s) => log(`status: ${s.status}`));

  const unsubscribe = client.onUpdate(
    api.dayRecorder.getSettings,
    {},
    (s) => void service.apply({ enabled: s.enabled, denylist: s.denylist, shotSec: s.shotSec }),
    (err) => log(`could not read Day Recorder settings: ${err?.message ?? err}`)
  );

  return {
    service,
    async stop() {
      unsubscribe();
      await service.shutdown();
      await client.close();
      log("stopped");
      logStream.end();
    },
    killSync: () => service.killSync(),
  };
}
