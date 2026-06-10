// WHAT: Minimal preload — exposes a tiny, safe surface to the renderer.
// WHY: contextIsolation is on; the renderer only needs to know it's inside Electron
// so it can pad the sidebar for the macOS traffic lights.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("geekspace", {
  isElectron: true,
  platform: process.platform,
});
