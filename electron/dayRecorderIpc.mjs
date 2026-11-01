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
const MAX_CALL_ID = 64;

function checkCallId(callId) {
  if (typeof callId !== "string" || callId.length === 0 || callId.length > MAX_CALL_ID) {
    throw new Error("An answer needs the call id it answers");
  }
  return callId;
}

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
  // The call notice's answers (plan PR 4b). The call id names which question is answered,
  // so an answer to an old prompt can't release a newer call.
  handle("gs:dayRecorder:noticeGiven", ({ callId }) => live().notice.given(checkCallId(callId)));
  handle("gs:dayRecorder:noticeDeclined", ({ callId }) => live().notice.declined(checkCallId(callId)));
  handle("gs:dayRecorder:extendNotice", ({ callId }) => live().notice.extend(checkCallId(callId)));
  handle("gs:dayRecorder:dismissCallWarning", () => live().notice.dismiss());
  // The prompt a page that opens now should show (events carry changes after that).
  handle("gs:dayRecorder:callPrompt", () => live().callPrompt());
}

/** Push every status change to the open windows. Returns the unsubscribe. */
export function forwardStatus({ service, windows }) {
  return service.onStatus((status) => {
    for (const win of windows()) {
      if (!win.isDestroyed()) win.webContents.send(DAY_RECORDER_EVENT, { type: "status", status });
    }
  });
}
