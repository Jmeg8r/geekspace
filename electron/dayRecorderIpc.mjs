// WHAT: the renderer's controls for the Day Recorder (plan PR 3d-1): the gs:dayRecorder:*
// handlers, the settings patch behind each control, and the status push to app windows.
// WHY through settings: every control is a saved settings change, and the main process
// already follows those by subscription (dayRecorderRuntime.mjs). So a control changes what
// is saved, and capture follows it, the same way after a relaunch as now.
// WHY handle() is passed in: main.mjs's handle() refuses any sender but the app page and
// wraps results as { ok, data | error }. Registering through it keeps that guard on every
// channel here, with no ipcMain of this module's own.

export const DAY_RECORDER_EVENT = "gs:dayRecorder:event";

const NOT_RUNNING = "The Day Recorder is not running. Restart Geekspace to try again.";

/** The settings patch behind each control. Turning on is a request to record, so it clears a saved pause. */
export function createDayRecorderControls(updateSettings) {
  return {
    setEnabled: (enabled) => updateSettings(enabled ? { enabled: true, paused: false } : { enabled: false }),
    pause: () => updateSettings({ paused: true }),
    resume: () => updateSettings({ paused: false }),
  };
}

/** Register the four control channels. `recorder()` is null when the recorder failed to start. */
export function registerDayRecorderIpc({ handle, recorder }) {
  const live = () => {
    const r = recorder();
    if (!r) throw new Error(NOT_RUNNING);
    return r;
  };
  handle("gs:dayRecorder:status", () => live().view.status());
  handle("gs:dayRecorder:setEnabled", ({ enabled }) => {
    if (typeof enabled !== "boolean") throw new Error("setEnabled needs true or false");
    return live().setEnabled(enabled);
  });
  handle("gs:dayRecorder:pause", () => live().pause());
  handle("gs:dayRecorder:resume", () => live().resume());
}

/** Push every status change to the open windows. Returns the unsubscribe. */
export function forwardStatus({ service, windows }) {
  return service.onStatus((status) => {
    for (const win of windows()) {
      if (!win.isDestroyed()) win.webContents.send(DAY_RECORDER_EVENT, { type: "status", status });
    }
  });
}
