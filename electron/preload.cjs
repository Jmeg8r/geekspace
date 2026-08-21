// WHAT: Preload bridge — a small, typed-ish surface the renderer can trust.
// WHY: contextIsolation stays on; only specific IPC channels are reachable.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, args) => ipcRenderer.invoke(channel, args);

const api = {
  isElectron: true,
  platform: process.platform,
  docs: {
    quickLook: (url, name) => invoke("gs:docs:quickLook", { url, name }),
  },
  agent: {
    status: () => invoke("gs:agent:status"),
    chat: (message, mode) => invoke("gs:agent:chat", { message, mode }),
    reset: () => invoke("gs:agent:reset"),
    onEvent: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("gs:agent:event", listener);
      return () => ipcRenderer.removeListener("gs:agent:event", listener);
    },
  },
  knowledge: {
    search: (query, limit) => invoke("gs:knowledge:search", { query, limit }),
    answer: (question) => invoke("gs:knowledge:answer", { question }),
    openExternal: (url) => invoke("gs:openExternal", { url }),
  },
  reader: {
    listFeeds: () => invoke("gs:reader:listFeeds"),
    recentItems: (limit, since, category) =>
      invoke("gs:reader:recentItems", { limit, since, category }),
    searchItems: (query, limit) => invoke("gs:reader:searchItems", { query, limit }),
    markProcessed: (itemIds, consumer) =>
      invoke("gs:reader:markProcessed", { itemIds, consumer }),
    addFeed: (url, category) => invoke("gs:reader:addFeed", { url, category }),
    removeFeed: (url) => invoke("gs:reader:removeFeed", { url }),
    pollFeeds: (categories) => invoke("gs:reader:pollFeeds", { categories }),
    openExternal: (url) => invoke("gs:openExternal", { url }),
  },
  meetings: {
    tools: () => invoke("gs:meeting:tools"),
    ollama: (url) => invoke("gs:meeting:ollama", { url }),
    askMic: () => invoke("gs:meeting:askMic"),
    ensureModel: () => invoke("gs:meeting:ensureModel"),
    process: (payload) => invoke("gs:meeting:process", payload),
    onProgress: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("gs:meeting:progress", listener);
      return () => ipcRenderer.removeListener("gs:meeting:progress", listener);
    },
  },
  chrome: {
    setOverlay: (color, symbolColor) => invoke("gs:chrome:setOverlay", { color, symbolColor }),
  },
};

// WHY: the renderer's integrationsAvailable() (src/lib/integrations.ts) keys
// off this property's mere presence, so omitting it on non-mac hides every
// Calendar/Mail surface (Settings "macOS integrations" section, the Home Mail
// widget, the calendar sync loop, "Open in Calendar" buttons) with zero
// renderer changes. A future Windows Calendar/Mail provider ships by exposing
// this same six-method shape here.
if (process.platform === "darwin") {
  api.integrations = {
    isRunning: (name) => invoke("gs:isRunning", { name }),
    openApp: (name) => invoke("gs:openApp", { name }),
    listCalendars: () => invoke("gs:listCalendars"),
    fetchCalendarEvents: (start, end, names) =>
      invoke("gs:fetchCalendarEvents", { start, end, names }),
    fetchInbox: (limit) => invoke("gs:fetchInbox", { limit }),
    openMessage: (messageId) => invoke("gs:openMessage", { messageId }),
  };
}

contextBridge.exposeInMainWorld("geekspace", api);
