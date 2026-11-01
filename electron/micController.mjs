// WHAT: the main process's handle on the hidden mic capture window (plan PR 3d-2). It opens
// the window while the Day Recorder is recording, feeds the window's messages to the segment
// writer, and turns what happens into the mic's state.
// WHY degrade, not stop (James, 2026-10-31): a denied, missing or dead mic leaves screens and
// system audio recording. The state says what went wrong and a capError records it, so the
// recorder never claims a full recording while the mic is out.
// WHY check the sender: this is the only code that accepts messages from the capture window,
// and those messages write into the media root. Anything from another webContents is ignored.

const STOP_TIMEOUT_MS = 5_000;
// The kinds src/capture/micCapture.ts reports. Its message is our own copy, kept short here
// because it lands in a capError event.
const WINDOW_ERROR_KINDS = new Set(["denied", "noDevice", "unavailable", "deviceLost", "recorderError"]);
const MAX_ERROR_CHARS = 200;

const COPY = {
  denied: "Microphone access is off for Geekspace. Turn it on in System Settings > Privacy & Security > Microphone.",
  windowGone: "The mic capture window stopped unexpectedly.",
};

export function createMicController({
  askMic,
  createWindow,
  createWriter,
  onState,
  recordError,
  log,
  stopTimeoutMs = STOP_TIMEOUT_MS,
}) {
  let win = null;
  let writer = null;
  let stopping = null;
  let onStopped = null;
  let starting = false;
  let state = { state: "off" };

  function setState(next) {
    state = next;
    onState(next);
  }

  function failMic(kind, error) {
    setState({ state: "error", kind, error });
    recordError(`mic: ${error}`);
  }

  async function start() {
    if (win || starting || stopping) return;
    starting = true;
    try {
      setState({ state: "starting" });
      if (!(await askMic())) {
        failMic("denied", COPY.denied);
        return;
      }
      writer = createWriter();
      win = createWindow({
        onGone: () => {
          if (!win) return;
          failMic("windowGone", COPY.windowGone);
          void teardown();
        },
      });
    } finally {
      starting = false;
    }
  }

  /** Whether `sender` is the capture window's own webContents. */
  function ownsSender(sender) {
    return win !== null && sender?.id === win.webContents.id;
  }

  /** One message from a renderer. Only the capture window's own webContents is heard. */
  function receive(sender, message) {
    if (!ownsSender(sender)) {
      log("ignored a mic message from another sender");
      return;
    }
    switch (message?.type) {
      case "stopped":
        onStopped?.();
        if (!stopping) void teardown();
        return;
      case "silent":
        if (!Number.isFinite(message.silentSec) || message.silentSec < 0) {
          failMic("protocol", "the capture window sent a malformed silence report");
          void stop();
          return;
        }
        if (state.state !== "error") setState({ state: "silent", silentSec: message.silentSec });
        return;
      case "signal":
        if (state.state !== "error") setState({ state: "ok" });
        return;
      case "error":
        if (!WINDOW_ERROR_KINDS.has(message.kind)) {
          failMic("protocol", "the capture window reported an unknown kind of error");
        } else {
          failMic(message.kind, String(message.message).slice(0, MAX_ERROR_CHARS));
        }
        return;
      default: {
        const result = writer.handle(message);
        if (!result.ok) {
          failMic("protocol", `the capture window sent a message that was refused (${result.reason})`);
          void stop();
          return;
        }
        // A stop can land just after a boundary, before the new segment has any audio; that
        // loses nothing. A segment that ran its course with no audio is a dead mic.
        if (result.empty && !stopping) failMic("noAudio", "The microphone delivered no audio for a whole segment.");
        if (message.type === "segmentStart" && state.state === "starting") setState({ state: "ok" });
      }
    }
  }

  async function teardown() {
    const w = win;
    const wr = writer;
    win = null;
    writer = null;
    if (w && !w.isDestroyed()) w.destroy();
    if (wr) await wr.close();
  }

  /** Ask the window to finish its open segment, wait for stopped (bounded), then close. */
  function stop() {
    if (stopping) return stopping;
    if (!win) {
      if (state.state !== "error") setState({ state: "off" });
      return Promise.resolve();
    }
    stopping = (async () => {
      let timer;
      const stopped = new Promise((resolve) => {
        onStopped = () => resolve(true);
        timer = setTimeout(() => resolve(false), stopTimeoutMs);
      });
      win.webContents.send("gs:mic:stop");
      if (!(await stopped)) log(`the mic capture window did not stop within ${stopTimeoutMs} ms; closing it`);
      clearTimeout(timer);
      onStopped = null;
      // The writer's own drain waits for the last segment's row.
      await writer?.drain();
      await teardown();
      if (state.state !== "error") setState({ state: "off" });
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  }

  return {
    start,
    stop,
    receive,
    ownsSender,
    state: () => state,
    isCaptureWindow: (w) => win !== null && w === win,
  };
}
