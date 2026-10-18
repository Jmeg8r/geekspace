// WHAT: Probe — run the real electron/convexBackend.mjs startOrAttach() inside a real
// Electron main process against a non-executable backend binary, and record what the
// user would see (Electron's default uncaught-exception dialog, stderr, the rejection).
// WHY: proves (or disproves) the instance-secret leak and the 30 s hang before fixing.
// Usage: PROBE_APPDATA=<tmp> PROBE_REPO=<repo> GEEKSPACE_CONVEX_BINARY=<644 file> electron main.mjs
import { app, dialog } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

app.setPath("appData", process.env.PROBE_APPDATA);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

// Observe, don't block: the default handler calls dialog.showErrorBox (a modal). Record its
// title/body instead so the probe runs unattended. NOTE: in the real app the modal blocks
// the main thread until dismissed, so the 30 s wait starts after the user clicks OK.
dialog.showErrorBox = (title, body) => console.log(`[probe ${stamp()}] showErrorBox title=${JSON.stringify(title)} body=${JSON.stringify(body)}`);

app.whenReady().then(async () => {
  console.log(`[probe ${stamp()}] uncaughtException listeners: ${process.listenerCount("uncaughtException")}`);
  const mod = await import(pathToFileURL(path.join(process.env.PROBE_REPO, "electron/convexBackend.mjs")).href);
  try {
    await mod.startOrAttach();
    console.log(`[probe ${stamp()}] startOrAttach resolved`);
  } catch (err) {
    console.log(`[probe ${stamp()}] startOrAttach rejected: ${err?.message}`);
  }
  try {
    await mod.stopBackend();
    mod.killBackendSync();
    console.log(`[probe ${stamp()}] stopBackend + killBackendSync returned`);
  } catch (err) {
    console.log(`[probe ${stamp()}] stop threw: ${err?.message}`);
  }
  app.exit(0);
});
