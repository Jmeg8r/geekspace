// WHAT: Preload bridge — a small, typed-ish surface the renderer can trust.
// WHY: contextIsolation stays on; only specific IPC channels are reachable.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, args) => ipcRenderer.invoke(channel, args);

contextBridge.exposeInMainWorld("geekspace", {
  isElectron: true,
  platform: process.platform,
  integrations: {
    isRunning: (name) => invoke("gs:isRunning", { name }),
    openApp: (name) => invoke("gs:openApp", { name }),
    listCalendars: () => invoke("gs:listCalendars"),
    fetchCalendarEvents: (start, end, names) =>
      invoke("gs:fetchCalendarEvents", { start, end, names }),
    fetchInbox: (limit) => invoke("gs:fetchInbox", { limit }),
    openMessage: (messageId) => invoke("gs:openMessage", { messageId }),
  },
  knowledge: {
    search: (query, limit) => invoke("gs:knowledge:search", { query, limit }),
    answer: (question) => invoke("gs:knowledge:answer", { question }),
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
});
