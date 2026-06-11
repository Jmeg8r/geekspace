// WHAT: Electron main process — creates the Geekspace window and exposes the
// macOS Calendar/Mail integration over IPC.
// WHY: kept dependency-free plain ESM so there is no build step for the main process.
import { app, BrowserWindow, ipcMain, shell, systemPreferences } from "electron";
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
  processMeeting,
  toolStatus,
} from "./meetingProcessor.mjs";
import {
  answerKnowledge,
  prewarmKnowledge,
  searchKnowledge,
} from "./knowledgeSearch.mjs";
import { architectAuthOk, resetArchitect, runArchitect } from "./architect.mjs";
import { localArchitectStatus, resetLocalArchitect, runArchitectLocal } from "./architectLocal.mjs";

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
ipcMain.handle("gs:agent:chat", async (event, { message, mode }) => {
  try {
    const run = mode === "claude" ? runArchitect : runArchitectLocal;
    await run(message, (frame) => {
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

app.whenReady().then(() => {
  createWindow();
  // Warm the knowledge connector (connect + tools/list only — no quota used).
  prewarmKnowledge().catch(() => {});
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
