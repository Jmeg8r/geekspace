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

// ----- ARCHITECT agent (ClaudeClaw) -----
const CLAUDECLAW_URL = process.env.CLAUDECLAW_URL ?? "http://127.0.0.1:3141";

handle("gs:agent:status", async () => {
  if (!process.env.CLAUDECLAW_TOKEN) return { state: "no-token" };
  try {
    const res = await fetch(`${CLAUDECLAW_URL}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return { state: res.ok ? "online" : "error" };
  } catch {
    return { state: "offline" };
  }
});

handle("gs:agent:reset", async () => {
  const res = await fetch(`${CLAUDECLAW_URL}/api/chat/geekspace/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLAUDECLAW_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Reset failed (${res.status})`);
  return true;
});

// Streams SSE frames from ClaudeClaw's chat endpoint to the renderer as
// push events (same pattern as meeting progress). Resolves when the stream ends.
ipcMain.handle("gs:agent:chat", async (event, { message }) => {
  const token = process.env.CLAUDECLAW_TOKEN;
  if (!token) {
    return { ok: false, error: "CLAUDECLAW_TOKEN is not set in .env.local" };
  }
  try {
    const res = await fetch(`${CLAUDECLAW_URL}/api/chat/geekspace`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `ClaudeClaw responded ${res.status}: ${body.slice(0, 200)}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawError = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const eventType = frame.match(/^event:\s*(\S+)/m)?.[1] ?? "message";
        const dataRaw = frame.match(/^data:\s*(.*)$/m)?.[1];
        let data = {};
        try {
          data = dataRaw ? JSON.parse(dataRaw) : {};
        } catch {
          data = { text: dataRaw };
        }
        if (eventType === "error") sawError = data.message ?? "agent error";
        event.sender.send("gs:agent:event", { type: eventType, ...data });
      }
    }
    if (sawError) return { ok: false, error: sawError };
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
