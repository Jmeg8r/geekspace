import {
  isAppUrl,
  externalUrl,
  localStorageUrl,
  viewerFilename,
  downloadDocument,
} from "./desktopSafety.mjs";
// WHAT: Electron main process — creates the Geekspace window and exposes the
// macOS Calendar/Mail integration over IPC.
// WHY: kept dependency-free plain ESM so there is no build step for the main process.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  systemPreferences,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchCalendarEvents,
  fetchInbox,
  isAppRunning,
  listCalendars,
  messageUrl,
  openApp,
} from "./integrations.mjs";
import {
  checkOllama,
  ensureModel,
  processMeeting,
  toolStatus,
} from "./meetingProcessor.mjs";
import {
  answerKnowledge,
  prewarmKnowledge,
  searchKnowledge,
} from "./knowledgeSearch.mjs";
import {
  addFeed,
  listFeeds,
  markProcessed,
  pollFeeds,
  prewarmReader,
  recentItems,
  removeFeed,
  searchItems,
} from "./readerMcp.mjs";
import { architectAuthOk, resetArchitect, runArchitect } from "./architect.mjs";
import {
  localArchitectStatus,
  resetLocalArchitect,
  runArchitectLocal,
} from "./architectLocal.mjs";
import {
  getUrl as convexUrl,
  isManaged as convexManaged,
  killBackendSync,
  startOrAttach as startConvex,
  stopBackend as stopConvex,
} from "./convexBackend.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = app.isPackaged
  ? undefined
  : process.env.VITE_DEV_SERVER_URL;
const entryUrl =
  devServerUrl ??
  pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
const trustedContents = new WeakSet();
function requireTrustedSender(event) {
  if (
    !trustedContents.has(event.sender) ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame ||
    !isAppUrl(event.senderFrame?.url, entryUrl)
  ) {
    throw new Error("IPC request is not from the workspace window");
  }
}
function push(event, channel, payload) {
  if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
}
async function openLink(url) {
  return shell.openExternal(externalUrl(url));
}

// WHY: Vite injects .env.local into the renderer only; the main process needs
// the same secrets (ASTGL_API_KEY, CLAUDECLAW_TOKEN) for its integrations.
try {
  const envFile = fs.readFileSync(
    path.join(__dirname, "..", ".env.local"),
    "utf8",
  );
  for (const line of envFile.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* no .env.local — fine */
}

// WHY: intentional behavior change — previously a second launch attached to
// the first instance's backend, and quitting the first killed the backend out
// from under the second; on Windows, single-instance-focus is also the
// idiomatic taskbar behavior.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 620,
    // WHY: hiddenInset floats mac traffic lights over our chrome; on Windows
    // the native Window Controls Overlay gives the same seamless look,
    // re-themed at runtime via gs:chrome:setOverlay; autoHideMenuBar keeps the
    // default menu's accelerators (Ctrl+Shift+I, Ctrl+R) working in dev
    // without a visible bar.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 18, y: 19 },
        }
      : process.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            titleBarOverlay: {
              color: "#1A1A2E",
              symbolColor: "#E8E8F0",
              height: 36,
            },
            autoHideMenuBar: true,
          }
        : {}),
    backgroundColor: "#1A1A2E",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  trustedContents.add(win.webContents);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url).catch((error) =>
      console.warn("Could not open link", error.message),
    );
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url, entryUrl)) {
      event.preventDefault();
      openLink(url).catch((error) =>
        console.warn("Could not open link", error.message),
      );
    }
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url, entryUrl)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const session = win.webContents.session;
  session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const trusted =
        contents &&
        trustedContents.has(contents) &&
        isAppUrl(contents.getURL(), entryUrl) &&
        isAppUrl(details.requestingUrl, entryUrl) &&
        details.isMainFrame;
      callback(
        Boolean(
          trusted &&
          permission === "media" &&
          details.mediaTypes?.length &&
          details.mediaTypes.every((type) => type === "audio"),
        ),
      );
    },
  );
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    Boolean(
      contents &&
      trustedContents.has(contents) &&
      isAppUrl(contents.getURL(), entryUrl) &&
      details.isMainFrame &&
      isAppUrl(details.requestingUrl, entryUrl) &&
      permission === "media" &&
      details.mediaType === "audio",
    ),
  );

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// IPC: every handler returns { ok, data?, error? } so the renderer never throws.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, args) => {
    try {
      requireTrustedSender(event);
      return { ok: true, data: await fn(args ?? {}, event) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });
}

// ----- Window chrome -----
// WHY: native caption buttons must follow the app theme (dark/light); no-op
// off Windows since only win32 has a Window Controls Overlay to re-theme.
// Height is pinned to 36 to match the renderer's drag strip.
handle("gs:chrome:setOverlay", ({ color, symbolColor }) => {
  if (process.platform !== "win32") return;
  const isHexColor = (s) =>
    typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
  if (!isHexColor(color) || !isHexColor(symbolColor)) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (typeof win.setTitleBarOverlay === "function") {
      win.setTitleBarOverlay({ color, symbolColor, height: 36 });
    }
  }
});

// WHY: defense in depth behind the preload gate — preload.cjs only attaches
// `integrations` on darwin, so the renderer can't reach these channels on
// Windows/Linux anyway, but we skip registering them at all. Also the seam
// where a future Windows Calendar/Mail provider would register its own
// gs:* handlers.
if (process.platform === "darwin") {
  handle("gs:isRunning", ({ name }) => isAppRunning(name));
  handle("gs:openApp", ({ name }) => openApp(name));
  handle("gs:listCalendars", () => listCalendars());
  handle("gs:fetchCalendarEvents", ({ start, end, names }) =>
    fetchCalendarEvents(start, end, names),
  );
  handle("gs:fetchInbox", ({ limit }) => fetchInbox(limit));
  handle("gs:openMessage", ({ messageId }) => {
    return shell.openExternal(messageUrl(messageId));
  });
}

// ----- AI Meeting Notes -----
handle("gs:meeting:tools", () => toolStatus());
handle("gs:meeting:ollama", ({ url }) => checkOllama(url));
handle("gs:meeting:askMic", async () => {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  return systemPreferences.askForMediaAccess("microphone");
});
ipcMain.handle("gs:meeting:ensureModel", async (event) => {
  try {
    requireTrustedSender(event);
    await ensureModel((pct) =>
      push(event, "gs:meeting:progress", { phase: "model", pct }),
    );
    return { ok: true, data: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});
ipcMain.handle("gs:meeting:process", async (event, args) => {
  try {
    requireTrustedSender(event);
    if (
      !(args?.audio instanceof ArrayBuffer) ||
      args.audio.byteLength === 0 ||
      args.audio.byteLength > 256 * 1024 * 1024
    )
      throw new Error("Invalid or oversized meeting audio");
    const result = await processMeeting(
      {
        audio: args.audio,
        meetingType: args.meetingType,
        ollamaUrl: args.ollamaUrl,
        ollamaModel: args.ollamaModel,
      },
      (p) =>
        push(event, "gs:meeting:progress", { meetingId: args.meetingId, ...p }),
    );
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// ----- Docs: open a stored file with the default macOS app -----
handle("gs:docs:quickLook", async ({ url, name }) => {
  const storageUrl = localStorageUrl(url, convexUrl());
  const filename = viewerFilename(name);
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "geekspace-doc-"),
  );
  try {
    const file = path.join(directory, filename);
    await downloadDocument(storageUrl, file);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    // Keep the private temp file briefly for the launched viewer to read.
    setTimeout(
      () =>
        fs.promises
          .rm(directory, { recursive: true, force: true })
          .catch((error) =>
            console.warn("Document cleanup failed", error.message),
          ),
      10 * 60 * 1000,
    ).unref();
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
});

// ----- ARCHITECT agent (two lanes: local Ollama default, Claude SDK escalation) -----
handle("gs:agent:status", async () => {
  // Claude lane needs the machine's Claude Code credentials (and from
  // 2026-06-15 bills the Agent SDK credit pool). Local lane needs Ollama.
  const local = await localArchitectStatus();
  return {
    state: architectAuthOk() ? "online" : "no-auth",
    local,
  };
});

handle("gs:agent:reset", async () => {
  resetArchitect();
  resetLocalArchitect();
  return true;
});

// Runs one ARCHITECT turn; streams token/tool/error frames to the renderer
// (same push pattern as meeting progress). mode "local" (default) drives the
// Ollama lane; "claude" escalates to the Agent SDK lane.
ipcMain.handle("gs:agent:chat", async (event, args) => {
  try {
    requireTrustedSender(event);
    const { message, mode } = args ?? {};
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 32000
    )
      throw new Error("Enter a message under 32000 characters");
    if (mode !== undefined && mode !== "local" && mode !== "claude")
      throw new Error("Unknown agent mode");
    const run = mode === "claude" ? runArchitect : runArchitectLocal;
    await run(message, (frame) => {
      push(event, "gs:agent:event", frame);
    });
    return { ok: true, data: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// ----- Enterprise Search (ASTGL knowledge) -----
handle("gs:knowledge:search", ({ query, limit }) =>
  searchKnowledge(query, limit),
);
handle("gs:knowledge:answer", ({ question }) => answerKnowledge(question));
handle("gs:openExternal", ({ url }) => {
  return openLink(url);
});

// ----- Reader (aib-reader RSS) -----
handle("gs:reader:listFeeds", () => listFeeds());
handle("gs:reader:recentItems", ({ limit, since, category }) =>
  recentItems({ limit, since, category }),
);
handle("gs:reader:searchItems", ({ query, limit }) =>
  searchItems(query, limit),
);
handle("gs:reader:markProcessed", ({ itemIds, consumer }) =>
  markProcessed(itemIds, consumer),
);
handle("gs:reader:addFeed", ({ url, category }) => addFeed(url, category));
handle("gs:reader:removeFeed", ({ url }) => removeFeed(url));
handle("gs:reader:pollFeeds", ({ categories }) => pollFeeds(categories));

app.whenReady().then(async () => {
  // WHY: closes the race where whenReady resolves before the app.quit() from a
  // failed single-instance lock (above) actually processes — without this,
  // a second launch could still attach a second backend and flash a window.
  if (!gotSingleInstanceLock) return;

  // Bring up (or attach to) the local Convex backend BEFORE the window loads —
  // the renderer hard-requires it on :3210. In dev this attaches to the
  // `convex dev` backend; packaged, it spawns the bundled binary.
  try {
    await startConvex();
  } catch (err) {
    const logDir = path.join(app.getPath("appData"), "Geekspace", "logs");
    const choice = await dialog.showMessageBox({
      type: "error",
      title: "Geekspace couldn't start",
      message: "Geekspace couldn't start its local database.",
      detail: `${err?.message ?? err}\n\nThe backend log has more detail.`,
      buttons: ["Open Log Folder", "Quit"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response === 0) await shell.openPath(logDir);
    app.quit();
    return;
  }
  // Authoritative CONVEX_URL for the ARCHITECT MCP subprocesses (the renderer
  // uses the build-time VITE_CONVEX_URL, which already points here).
  process.env.CONVEX_URL = convexUrl();

  createWindow();
  // Warm the knowledge connector (connect + tools/list only — no quota used).
  prewarmKnowledge().catch((error) =>
    console.warn("Knowledge unavailable", error.message),
  );
  // Warm the reader connector (spawns aib-reader-mcp + tools/list).
  prewarmReader().catch((error) =>
    console.warn("Reader unavailable", error.message),
  );
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stop our backend after windows accept closing, so a beforeunload save guard
// can keep the editor and database available for retry.
let shuttingDown = false;
app.on("will-quit", (event) => {
  if (shuttingDown || !convexManaged()) return;
  event.preventDefault();
  shuttingDown = true;
  stopConvex().finally(() => app.quit());
});

// Last resort: never leak the backend if the parent dies unexpectedly.
process.on("exit", killBackendSync);
