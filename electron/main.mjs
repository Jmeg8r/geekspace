// WHAT: Electron main process — creates the Geekspace window and exposes the
// macOS Calendar/Mail integration over IPC.
// WHY: kept dependency-free plain ESM so there is no build step for the main process.
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from "electron";
import fs from "node:fs";
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
import {
  checkOllama,
  ensureModel,
  notesFromTranscript,
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
import { oneTurnAtATime } from "./agentShared.mjs";
import { localArchitectStatus, resetLocalArchitect, runArchitectLocal } from "./architectLocal.mjs";
import {
  getUrl as convexUrl,
  isManaged as convexManaged,
  killBackendSync,
  startOrAttach as startConvex,
  stopBackend as stopConvex,
} from "./convexBackend.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

// WHY: Vite injects .env.local into the renderer only; the main process needs
// the same secrets (ASTGL_API_KEY, CLAUDECLAW_TOKEN) for its integrations.
try {
  const envFile = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
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
            titleBarOverlay: { color: "#1A1A2E", symbolColor: "#E8E8F0", height: 36 },
            autoHideMenuBar: true,
          }
        : {}),
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

  // A reload or a crashed renderer takes any live recording with it, so stop guarding.
  win.webContents.on("did-navigate", () => {
    recordingActive = false;
  });
  win.webContents.on("render-process-gone", () => {
    recordingActive = false;
  });
  win.on("close", (event) => {
    // While the save handshake runs, nothing may close the window under it.
    if (guarding) {
      event.preventDefault();
      return;
    }
    if (!recordingActive || leaveApproved) return;
    event.preventDefault();
    void confirmLeaveWhileRecording(win);
  });

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

// ----- Window chrome -----
// WHY: native caption buttons must follow the app theme (dark/light); no-op
// off Windows since only win32 has a Window Controls Overlay to re-theme.
// Height is pinned to 36 to match the renderer's drag strip.
handle("gs:chrome:setOverlay", ({ color, symbolColor }) => {
  if (process.platform !== "win32") return;
  const isHexColor = (s) => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
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
    fetchCalendarEvents(start, end, names)
  );
  handle("gs:fetchInbox", ({ limit }) => fetchInbox(limit));
  handle("gs:openMessage", ({ messageId }) => {
    shell.openExternal(messageUrl(messageId));
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
    await ensureModel((pct) =>
      event.sender.send("gs:meeting:progress", { phase: "model", pct })
    );
    return { ok: true, data: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});
ipcMain.handle("gs:meeting:process", async (event, args) => {
  try {
    const result = await processMeeting(
      {
        audio: args.audio,
        meetingType: args.meetingType,
        ollamaUrl: args.ollamaUrl,
        ollamaModel: args.ollamaModel,
      },
      (p) =>
        event.sender.send("gs:meeting:progress", { meetingId: args.meetingId, ...p })
    );
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

ipcMain.handle("gs:meeting:summarize", async (event, args) => {
  try {
    if (typeof args?.transcript !== "string" || !args.transcript.trim()) {
      throw new Error("No transcript to summarise");
    }
    const result = await notesFromTranscript(
      args.transcript,
      typeof args.meetingType === "string" ? args.meetingType : "general",
      args.ollamaUrl,
      args.ollamaModel,
      (pct) => event.sender.send("gs:meeting:progress", { meetingId: args.meetingId, phase: "summarizing", pct })
    );
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// ----- Quit guard: never discard a live meeting recording -----
// WHY: the audio lives in renderer memory until Stop, so quitting or closing the window
// mid-meeting used to throw it away. The renderer reports when it is recording; leaving
// then asks first, and Save has the renderer stop and upload before anything shuts down
// (the upload goes to the local backend, which before-quit stops).
const SAVE_ON_QUIT_TIMEOUT_MS = 2 * 60 * 1000;
let recordingActive = false;
let leaveApproved = false;
let guarding = false;
let pendingSave = null;

handle("gs:recorder:setActive", ({ active }) => {
  recordingActive = active === true;
  // A new recording after an approved-but-unfinished quit must be guarded again.
  if (recordingActive && !guarding) leaveApproved = false;
});
handle("gs:recorder:saveDone", ({ ok, error }) => {
  pendingSave?.({ ok: ok === true, error: typeof error === "string" ? error : "Unknown error" });
});

function requestSave(win) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSave = null;
      resolve({ ok: false, error: "Saving the recording took longer than 2 minutes." });
    }, SAVE_ON_QUIT_TIMEOUT_MS);
    pendingSave = (result) => {
      clearTimeout(timer);
      pendingSave = null;
      resolve(result);
    };
    win.webContents.send("gs:recorder:saveRequest");
  });
}

async function confirmLeaveWhileRecording(win) {
  if (guarding) return;
  guarding = true;
  let approved = false;
  try {
    const choice = await dialog.showMessageBox(win, {
      type: "warning",
      message: "A meeting is still recording.",
      detail: "Save the recording before quitting? It's uploaded now and you can process it next time.",
      buttons: ["Save Recording and Quit", "Keep Recording"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return;
    const result = await requestSave(win);
    if (!result.ok) {
      const again = await dialog.showMessageBox(win, {
        type: "error",
        message: "The recording couldn't be saved.",
        detail: `${result.error}\n\nQuitting now loses it.`,
        buttons: ["Keep App Open", "Quit Anyway"],
        defaultId: 0,
        cancelId: 0,
      });
      if (again.response !== 1) return;
    }
    approved = true;
  } finally {
    guarding = false;
  }
  // WHY after the finally: app.quit() re-enters before-quit, which holds any quit while
  // `guarding` is set; the approved quit must not be cancelled by its own guard.
  if (approved) {
    recordingActive = false;
    leaveApproved = true;
    app.quit();
  }
}

// ----- Docs: open a stored file with the default macOS app -----
handle("gs:docs:quickLook", async ({ url, name }) => {
  if (typeof url !== "string" || !url.startsWith("http://127.0.0.1")) {
    throw new Error("Only local storage URLs can be opened");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const safeName = path.basename(String(name || "file")).replace(/[^\w.\- ]+/g, "_");
  const tmpFile = path.join(app.getPath("temp"), `geekspace-${Date.now()}-${safeName}`);
  await fs.promises.writeFile(tmpFile, buf);
  await shell.openPath(tmpFile);
  // Best-effort cleanup after the viewer has had time to read it.
  setTimeout(() => fs.promises.unlink(tmpFile).catch(() => {}), 10 * 60 * 1000);
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
// One turn at a time across both lanes: a second message mid-turn would interleave
// with the running conversation.
const runAgentTurn = oneTurnAtATime((mode, message, onEvent) =>
  mode === "claude" ? runArchitect(message, onEvent) : runArchitectLocal(message, onEvent)
);
ipcMain.handle("gs:agent:chat", async (event, { message, mode }) => {
  try {
    await runAgentTurn(mode, message, (frame) => {
      event.sender.send("gs:agent:event", frame);
    });
    return { ok: true, data: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
});

// ----- Enterprise Search (ASTGL knowledge) -----
handle("gs:knowledge:search", ({ query, limit }) => searchKnowledge(query, limit));
handle("gs:knowledge:answer", ({ question }) => answerKnowledge(question));
handle("gs:openExternal", ({ url }) => {
  if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// ----- Reader (aib-reader RSS) -----
handle("gs:reader:listFeeds", () => listFeeds());
handle("gs:reader:recentItems", ({ limit, since, category }) =>
  recentItems({ limit, since, category })
);
handle("gs:reader:searchItems", ({ query, limit }) => searchItems(query, limit));
handle("gs:reader:markProcessed", ({ itemIds, consumer }) => markProcessed(itemIds, consumer));
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
  prewarmKnowledge().catch(() => {});
  // Warm the reader connector (spawns aib-reader-mcp + tools/list).
  prewarmReader().catch(() => {});
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Graceful backend shutdown — only when WE own the process (never kill a
// `convex dev` we merely attached to). before-quit can fire before async work
// settles, so defer the real quit until SIGTERM completes.
let shuttingDown = false;
app.on("before-quit", (event) => {
  // The recording guard runs first: saving needs the backend still up. While the save
  // handshake runs, a second quit is held back too (the recorder is idle by then).
  if (guarding) {
    event.preventDefault();
    return;
  }
  const win = BrowserWindow.getAllWindows()[0];
  if (recordingActive && !leaveApproved && win) {
    event.preventDefault();
    void confirmLeaveWhileRecording(win);
    return;
  }
  if (shuttingDown || !convexManaged()) return;
  event.preventDefault();
  shuttingDown = true;
  stopConvex().finally(() => app.quit());
});

// Last resort: never leak the backend if the parent dies unexpectedly.
process.on("exit", killBackendSync);
