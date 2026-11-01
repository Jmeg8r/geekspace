// WHAT: the main process's handle on the hidden mic capture window (plan PR 3d-2). It opens
// the window while the Day Recorder is recording, feeds the window's messages to the segment
// writer, and turns what happens into the mic's state.
// WHY degrade, not stop (James, 2026-10-31): a denied, missing or dead mic leaves screens and
// system audio recording. The state says what went wrong and a capError records it, so the
// recorder never claims a full recording while the mic is out.
// WHY check the sender: this is the only code that accepts messages from the capture window,
// and those messages write into the media root. Anything from another webContents is ignored.
// WHY `wanted` (Codex #89 r1): start and stop say what the recorder wants, and the controller
// works toward the latest want. A stop while permission is pending cancels the start; a start
// during a stop runs once the stop is done. A failure ends the mic for this recording: the
// runtime calls start on every Recording status, and the failure itself re-emits Recording,
// so the window comes back only after a stop and a new start.

const STOP_TIMEOUT_MS = 5_000;
// The kinds src/capture/micCapture.ts reports. Its message is our own copy, kept short here
// because it lands in a capError event.
const WINDOW_ERROR_KINDS = new Set(["denied", "noDevice", "unavailable", "deviceLost", "recorderError"]);
const MAX_ERROR_CHARS = 200;

const COPY = {
  denied: "Microphone access is off for Geekspace. Turn it on in System Settings > Privacy & Security > Microphone.",
  windowGone: "The mic capture window stopped unexpectedly.",
  noAudio: "The microphone delivered no audio for a whole segment.",
  cancelled: "The recorder stopped before the mic window started.",
};

export function createMicController({
  askMic,
  createWindow,
  createWriter,
  onState,
  recordError,
  log,
  micConfig,
  stopTimeoutMs = STOP_TIMEOUT_MS,
}) {
  // Set by shutdown (quit): nothing starts again. WHY (Codex #89 r2): at quit the service is
  // still Recording, so the mic's own "off" re-emits Recording and the runtime calls start.
  let shutDown = false;
  let wanted = false;
  // Set by any failure, cleared by the next start after a stop: a failed mic stays down for
  // the rest of this recording, even when its own close finishes.
  let failed = false;
  let win = null;
  let writer = null;
  // The start in progress; a second start while macOS is asking joins it, never asks again.
  let starting = null;
  // The window being asked to finish; its promise is shared by every stop that arrives meanwhile.
  let closing = null;
  let onStopped = null;
  // The last teardown, so a later stop can wait for its row writes.
  let tearingDown = null;
  let state = { state: "off" };

  function setState(next) {
    state = next;
    onState(next);
  }

  function failMic(kind, error) {
    failed = true;
    setState({ state: "error", kind, error });
    recordError(`mic: ${error}`);
  }

  function begin() {
    if (!starting) {
      starting = openWindow().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  /** Ask for the mic, then open the window and its writer, unless a stop came meanwhile. */
  async function openWindow() {
    setState({ state: "starting" });
    const granted = await askMic();
    // A stop arrived while macOS was asking: nothing opens.
    if (!wanted) return;
    if (!granted) {
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
  }

  /** The recorder is Recording: run the mic, unless it already runs or failed this recording. */
  function start() {
    if (wanted || shutDown) return Promise.resolve();
    wanted = true;
    failed = false;
    // A start whose permission ask is still out opens the window once it is answered.
    if (starting) return starting;
    // The stop in progress starts the mic again when it finishes (see closeWindow).
    if (closing) return closing;
    if (tearingDown) return tearingDown.then(() => (wanted && !failed && !win && !starting ? begin() : undefined));
    return begin();
  }

  /** The recorder is not Recording: finish the open segment and close the window. */
  function stop() {
    wanted = false;
    if (closing) return closing;
    if (win) return closeWindow();
    if (tearingDown) return tearingDown.then(settleOff);
    settleOff();
    return Promise.resolve();
  }

  /**
   * A call started (plan PR 4b): the open segment may hold the call's opening audio, so it is
   * dropped, not finished (Codex review of PR 4b, round 3); then the mic stops as usual.
   */
  function discard() {
    writer?.discardOpen();
    return stop();
  }

  function settleOff() {
    // The runtime calls stop on every status but Recording; only a change is news.
    if (!wanted && state.state !== "error" && state.state !== "off") setState({ state: "off" });
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
        if (!closing) {
          // Stopped unasked: after its own error that is expected, otherwise the mic just went quiet.
          if (!failed) failMic("windowGone", COPY.windowGone);
          void teardown();
        }
        return;
      case "silent":
        if (!Number.isFinite(message.silentSec) || message.silentSec < 0) {
          failMic("protocol", "the capture window sent a malformed silence report");
          void closeWindow();
          return;
        }
        if (state.state === "error" || state.state === "silent") return;
        // One capError per episode: the warning, not every second of it.
        setState({ state: "silent", silentSec: message.silentSec });
        recordError(`mic: no signal for ${message.silentSec} s`);
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
          void closeWindow();
          return;
        }
        // A stop can land just after a boundary, before the new segment has any audio; that
        // loses nothing. A segment that ran its course with no audio is a dead mic.
        if (result.empty && !closing) failMic("noAudio", COPY.noAudio);
        if (message.type === "segmentStart" && state.state === "starting") setState({ state: "ok" });
      }
    }
  }

  /**
   * Close the window and its writer. One teardown at a time: a second call while one is still
   * writing its last row joins it, never replaces it (Codex #89 r2: a crash during a stop).
   */
  function teardown() {
    if (!win && !writer && tearingDown) return tearingDown;
    const w = win;
    const wr = writer;
    win = null;
    writer = null;
    if (w && !w.isDestroyed()) w.destroy();
    const done = (async () => {
      if (wr) await wr.close();
    })().finally(() => {
      if (tearingDown === done) tearingDown = null;
    });
    tearingDown = done;
    return done;
  }

  /** Ask the window to finish its open segment, wait for stopped (bounded), then close. */
  function closeWindow() {
    if (closing) return closing;
    const w = win;
    closing = (async () => {
      let timer;
      const stopped = new Promise((resolve) => {
        onStopped = () => resolve(true);
        timer = setTimeout(() => resolve(false), stopTimeoutMs);
      });
      w.webContents.send("gs:mic:stop");
      if (!(await stopped)) log(`the mic capture window did not stop within ${stopTimeoutMs} ms; closing it`);
      clearTimeout(timer);
      onStopped = null;
      // The writer's own drain waits for the last segment's row. A window that crashed during
      // this stop has already started its teardown; that one is awaited, not skipped.
      await writer?.drain();
      await teardown();
    })().finally(() => {
      closing = null;
      // A start that arrived during this stop runs now; otherwise the mic is off.
      if (wanted && !failed) void begin();
      else settleOff();
    });
    return closing;
  }

  /**
   * The capture page's config request, which it makes after registering for stop and before
   * anything else. A stop sent before the page listened was lost, so it is answered here
   * (Codex #89 r2). Null for any other sender.
   */
  function configFor(sender) {
    if (!ownsSender(sender)) return null;
    if (!wanted || closing) return { ok: false, cancelled: true, error: COPY.cancelled };
    return { ok: true, data: micConfig };
  }

  /** Quit: stop for good. */
  function shutdown() {
    shutDown = true;
    return stop();
  }

  return {
    start,
    stop,
    discard,
    shutdown,
    receive,
    ownsSender,
    configFor,
    state: () => state,
    isCaptureWindow: (w) => win !== null && w === win,
  };
}
