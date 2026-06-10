// WHAT: Electron main process — creates the Geekspace window.
// WHY: kept dependency-free plain ESM so there is no build step for the main process.
import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
