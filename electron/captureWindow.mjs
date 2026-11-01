// WHAT: the Day Recorder's hidden mic window (plan PR 3d-2), shared by the app's runtime and
// probe:segment-decode so the probe drives exactly the window the app opens.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The hidden mic window: never shown, its own narrow preload, no navigation and no popups.
 * WHY backgroundThrottling off: a hidden window's timers are throttled, and the segment
 * boundary and the silence meter run on timers.
 */
export function createCaptureWindow({ page, onGone }) {
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "capturePreload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", () => onGone());
  win.on("closed", () => onGone());
  if (page.devServerUrl) win.loadURL(new URL("capture.html", page.devServerUrl).href);
  else win.loadFile(page.file);
  return win;
}
