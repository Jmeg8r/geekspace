// WHAT: builds the Day Recorder service with its real parts for main.mjs (plan PR 3c): the
// bundled gs-capture, the media root under app data, the start gates, a main-process Convex
// client, and a log file next to the backend's.
// WHY a main-process client: capture runs whether or not a window is open, so the rows for
// what the helper writes can't depend on the renderer. Settings arrive by subscription, so
// turning the recorder on, pausing it, or editing the denylist reaches the helper the same
// way whether the change came from the renderer's controls (dayRecorderIpc.mjs) or not.
// The mic runs in a hidden window of its own while the recorder is recording (plan PR 3d-2).
// The menu bar shows the status view while the recorder is on, and ⌥⌘R pauses (plan PR 3e-1).
import { app, globalShortcut, ipcMain, Menu, nativeImage, systemPreferences, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ConvexClient } from "convex/browser";
// The generated `api` is exactly `anyApi` (convex/_generated/api.js), and convex/ is not
// packaged into the app, so the main process uses anyApi directly.
import { anyApi as api } from "convex/server";
import { createCaptureWindow } from "./captureWindow.mjs";
import { contentFreeLogger, createFileLog, createSupervisor } from "./dayRecorder.mjs";
import { checkFileVault, ensureBackupExclusion } from "./dayRecorderGates.mjs";
import { ensureMediaRoot, purgeExpired, resolveMediaPath } from "./dayRecorderMedia.mjs";
import { transcribeFile } from "./meetingProcessor.mjs";
import { createTranscriptionQueue } from "./transcriptionQueue.mjs";
import { createLinearDrafts } from "./linearDrafts.mjs";
import { createDayAssistant } from "./dayAssistant.mjs";
import { createDayRecorderControls } from "./dayRecorderIpc.mjs";
import { SEGMENT_SEC, createDayRecorderService } from "./dayRecorderService.mjs";
import { createStatusView, startRecorderIndicator, trayImage } from "./dayRecorderTray.mjs";
import { createCallDetector } from "./callDetector.mjs";
import { createCallNotice, statusWithCall } from "./callNotice.mjs";
import { createMicController } from "./micController.mjs";
import { createMicSegmentWriter } from "./micSegments.mjs";

const GEEKSPACE_DIR = path.join(app.getPath("appData"), "Geekspace");
// MediaRecorder's timeslice: how often a chunk crosses to the main process.
const MIC_TIMESLICE_MS = 1000;
const REFUSED = { ok: false, error: "Refused: the request did not come from the mic capture window" };


function helperPath() {
  // Packaged: Contents/Resources/gs-capture (package.json mac.extraResources).
  // Dev: what `npm run build:gs-capture` builds.
  return app.isPackaged
    ? path.join(process.resourcesPath, "gs-capture")
    : path.join(app.getAppPath(), "native", "gs-capture", ".build", "release", "gs-capture");
}

/**
 * Start following the Day Recorder settings. Returns a handle main.mjs stops on quit.
 * `capturePage` is where the mic window's page is: the dev server, or dist/capture.html.
 * `showApp` brings the app window forward, for the menu bar's "Open Geekspace".
 */
export function startDayRecorder({ convexUrl, capturePage, showApp, keyStore, linearKeyStore }) {
  const logDir = path.join(GEEKSPACE_DIR, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = createFileLog(path.join(logDir, "day-recorder.log"));
  const log = logFile.log;

  const client = new ConvexClient(convexUrl, { logger: contentFreeLogger(log) });
  const mediaDir = path.join(GEEKSPACE_DIR, "day-recorder");
  // Off macOS the service never starts a helper, so it never needs the folder either.
  const mediaRoot = process.platform === "darwin" ? ensureMediaRoot(mediaDir) : mediaDir;
  const rows = (fn) => async (args) => {
    await client.mutation(fn, args);
  };

  const service = createDayRecorderService({
    platform: process.platform,
    mediaRoot,
    helperPath: helperPath(),
    gates: { fileVault: () => checkFileVault(), backupExclusion: (root) => ensureBackupExclusion(root) },
    createSupervisor,
    convex: {
      addScreenshot: rows(api.dayRecorder.addScreenshot),
      addSegment: rows(api.dayRecorder.addSegment),
      logEvent: (event) => logEvent(event),
    },
    purge: async () => {
      await purgeExpired({
        root: mediaRoot,
        now: Date.now(),
        listExpired: (now) => client.query(api.dayRecorder.expiredMedia, { now }),
        markPurged: rows(api.dayRecorder.markPurged),
        log,
      });
    },
    log,
  });
  const logEvent = (event) => rows(api.dayRecorder.logEvent)({ at: Date.now(), ...event });
  const mic = createMicController({
    // macOS asks once, then answers from the saved choice; elsewhere there is no recorder.
    askMic: async () => process.platform !== "darwin" || systemPreferences.askForMediaAccess("microphone"),
    createWindow: ({ onGone }) => createCaptureWindow({ page: capturePage, onGone }),
    createWriter: () => createMicSegmentWriter({ root: mediaRoot, addSegment: rows(api.dayRecorder.addSegment), log }),
    onState: (s) => {
      log(`mic: ${s.state}${s.state === "error" ? ` (${s.kind})` : ""}`);
      service.setMic(s);
    },
    micConfig: { segmentSec: SEGMENT_SEC, timesliceMs: MIC_TIMESLICE_MS },
    recordError: (detail) =>
      logEvent({ kind: "capError", detail }).catch((err) => log(`could not record a capError event (${err?.name ?? "Error"})`)),
    log,
  });
  ipcMain.on("gs:mic:event", (event, message) => mic.receive(event.sender, message));
  ipcMain.handle("gs:mic:config", (event) => mic.configFor(event.sender) ?? REFUSED);
  // The mic follows the recorder: on while Recording, finished and closed otherwise.
  // Calls and the room-mic pause (plan PR 4b). The mic records while the recorder records,
  // except while a never-record app uses audio (F2) and while a call waits for its notice or
  // was declined (F3): it stops, so nothing of the call reaches disk before the notice.
  let denylistedAudio = false;
  let prompt = null;
  const promptListeners = new Set();
  const syncMic = () => {
    const recording = service.status().status === "recording";
    void (recording && !denylistedAudio && !notice.micHeld() ? mic.start() : mic.stop());
  };
  const notice = createCallNotice({
    helper: service.calls,
    // The event's id is what the released call segments carry (convex addSegment checks it).
    logEvent: (event) => client.mutation(api.dayRecorder.logEvent, { at: Date.now(), ...event }),
    onPrompt: (next) => {
      prompt = next;
      log(`call notice: ${next ? next.state : "closed"}`);
      for (const cb of promptListeners) cb(next);
    },
    onMicHeld: () => syncMic(),
    log,
  });
  const detector = createCallDetector({
    onCall: (call) => (call.active ? notice.callStarted(call.app) : notice.callEnded()),
    onDenylistedAudio: (active) => {
      denylistedAudio = active;
      log(active ? "room mic paused: a never-record app is using audio" : "room mic back: no never-record app is using audio");
      syncMic();
    },
  });
  service.onAudioUse((use) => detector.receive(use));
  service.onStatus((s) => {
    // A helper that stops drops anything it held, and a new one reports every app afresh.
    if (s.status !== "recording") {
      notice.recorderStopped();
      detector.reset();
    }
    syncMic();
  });

  // The error is the helper's own failure message or a gate's copy, never captured content.
  // With it, this log alone times the R3 proofs (part2-runbook.md) until the UI lands in 3e.
  service.onStatus((s) =>
    log(`status: ${s.status}${s.error ? ` (${s.error})` : ""}${s.retryInMs ? `; retry in ${Math.round(s.retryInMs / 1000)} s` : ""}`)
  );

  // Local transcription (plan PR 5, spec R7): every closed segment, oldest first, with
  // small.en. The backend lists what is waiting, so a backlog after a restart is picked up too.
  const transcription = createTranscriptionQueue({
    transcribe: (file) => transcribeFile({ input: file, model: "small.en" }),
    resolvePath: (rel) => resolveMediaPath(mediaRoot, rel),
    addTranscript: rows(api.dayRecorder.addTranscript),
    setSegmentStatus: (segmentId, status) => rows(api.dayRecorder.setSegmentStatus)({ segmentId, status }),
    log,
  });
  const unsubscribePending = client.onUpdate(
    api.dayRecorder.pendingSegments,
    {},
    (pending) => transcription.offer(pending),
    (err) => log(`could not read the segments waiting for transcription: ${err?.message ?? err}`)
  );

  // The assistant (plan PR 6a, spec R8): a batch every batchMin minutes while the recorder is
  // on. The key is read from the Keychain-encrypted store only when a request is made (F4).
  const assistant = createDayAssistant({
    client: () => {
      const key = keyStore?.get();
      return key ? new Anthropic({ apiKey: key }) : null;
    },
    convex: {
      input: (window) => client.query(api.assistant.input, window),
      applyActions: (actions) => client.mutation(api.assistant.applyActions, { actions, tzOffsetMin: new Date().getTimezoneOffset() }),
      recordUsage: (row) => client.mutation(api.assistant.recordUsage, row),
      capStatus: (day) => client.query(api.assistant.capStatus, { day }),
      logEvent: (event) => logEvent(event),
      watermark: () => client.query(api.assistant.watermark, {}),
      setWatermark: (at) => client.mutation(api.assistant.setWatermark, { at }),
    },
    log,
  });
  // Linear drafts (plan PR 6b, spec R12): sent only when James approves one.
  const linear = createLinearDrafts({
    keyStore: { get: () => linearKeyStore?.get() ?? null },
    fetch: globalThis.fetch,
    convex: {
      draft: (draftId) => client.query(api.assistant.draft, { draftId }),
      setStatus: (draftId, status) => client.mutation(api.assistant.setDraftStatus, { draftId, status }),
    },
    log,
  });
  let batchTimer = null;
  let batchMs = 0;
  const scheduleAssistant = (enabled, batchMin) => {
    const every = enabled ? batchMin * 60_000 : 0;
    if (every === batchMs) return;
    clearInterval(batchTimer);
    batchTimer = null;
    batchMs = every;
    if (every > 0) batchTimer = setInterval(() => void assistant.runBatch(), every);
  };

  const unsubscribe = client.onUpdate(
    api.dayRecorder.getSettings,
    {},
    (s) => {
      void service.apply({ enabled: s.enabled, paused: s.paused, denylist: s.denylist, shotSec: s.shotSec });
      scheduleAssistant(s.enabled, s.batchMin);
    },
    (err) => log(`could not read Day Recorder settings: ${err?.message ?? err}`)
  );

  const controls = createDayRecorderControls(rows(api.dayRecorder.updateSettings));
  // The tray and the windows see "Call — not saved yet" while the question is open.
  const view = createStatusView({
    status: () => statusWithCall(service.status(), prompt),
    onStatus(cb) {
      const offStatus = service.onStatus((s) => cb(statusWithCall(s, prompt)));
      const onPrompt = () => cb(statusWithCall(service.status(), prompt));
      promptListeners.add(onPrompt);
      return () => {
        offStatus();
        promptListeners.delete(onPrompt);
      };
    },
  });
  const indicator = startRecorderIndicator({
    view,
    platform: process.platform,
    createTray: (image) => new Tray(image),
    buildMenu: (items) => Menu.buildFromTemplate(items),
    createImage: (tone) => trayImage(nativeImage, tone),
    globalShortcut,
    controls,
    showApp,
    log,
  });

  return {
    linear,
    service,
    view,
    notice: {
      given: (callId) => notice.given(callId),
      declined: (callId) => notice.declined(callId),
      extend: (callId) => notice.extend(callId),
      dismiss: () => notice.dismiss(),
    },
    callPrompt: () => prompt,
    onCallPrompt(cb) {
      promptListeners.add(cb);
      return () => promptListeners.delete(cb);
    },
    ...controls,
    isCaptureWindow: (win) => mic.isCaptureWindow(win),
    async stop() {
      clearInterval(batchTimer);
      unsubscribe();
      unsubscribePending();
      // Capture stops first and now; the segment being transcribed finishes meanwhile, and the
      // backend stays up for its row (Codex review of PR 5: a slow write kept capture going).
      const transcribing = transcription.stop();
      // The mic first: its last segment's row needs the backend, like the helper's.
      await mic.shutdown();
      await service.shutdown();
      await transcribing;
      // Only now: the menu bar says Recording for as long as anything is still capturing.
      indicator.stop();
      view.stop();
      ipcMain.removeAllListeners("gs:mic:event");
      ipcMain.removeHandler("gs:mic:config");
      await client.close();
      log("stopped");
      logFile.end();
    },
    killSync: () => service.killSync(),
  };
}
