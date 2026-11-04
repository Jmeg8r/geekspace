// WHAT: the hidden mic capture window's own preload (plan PR 3d-2): three named calls.
// WHY its own file: this window streams audio bytes that the main process writes into the
// media root. The main window's preload (preload.cjs) never carries these channels, and main
// accepts them only from the capture window's own webContents (micController.mjs).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gsCapture", {
  /** { segmentSec, timesliceMs } from the main process. */
  config: () => ipcRenderer.invoke("gs:mic:config"),
  /** One event from src/capture/micCapture.ts. send, not invoke: delivery is in order. */
  event: (event) => ipcRenderer.send("gs:mic:event", event),
  /** Main asks the window to finish its open segment and report stopped. */
  onStop: (cb) => {
    ipcRenderer.on("gs:mic:stop", () => cb());
  },
});
