// WHAT: Electron main process — creates the Geekspace window and exposes the
// macOS Calendar/Mail integration over IPC.
// WHY: kept dependency-free plain ESM so there is no build step for the main process.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchCalendarEvents,
  fetchInbox,
  isAppRunning,
  listCalendars,
  messageUrl,
  openApp,
} from "./integrations.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 620,
    // WHY: hiddenInset gives the native macOS traffic lights floating over our own chrome.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: "#1A1A2E",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // WHY: external links must open in the user's browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const isInternal =
      (devServerUrl && url.startsWith(devServerUrl)) || url.startsWith("file://");
    if (!isInternal) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// IPC: every handler returns { ok, data?, error? } so the renderer never throws.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, args) => {
    try {
      return { ok: true, data: await fn(args ?? {}) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });
}

handle("gs:isRunning", ({ name }) => isAppRunning(name));
handle("gs:openApp", ({ name }) => openApp(name));
handle("gs:listCalendars", () => listCalendars());
handle("gs:fetchCalendarEvents", ({ start, end, names }) =>
  fetchCalendarEvents(start, end, names)
);
handle("gs:fetchInbox", ({ limit }) => fetchInbox(limit));
handle("gs:openMessage", ({ messageId }) => {
  shell.openExternal(messageUrl(messageId));
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
