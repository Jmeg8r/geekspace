// WHAT: the Electron half of probe:segment-decode (plan PR 3d-2). Runs the real capture
// window, capture preload, mic controller and segment writer with a short segment, against
// Chromium's fake audio device, until two segments have finished; then writes their rows to
// PROBE_OUT/result.json and quits. scripts/probe-segment-decode.mjs launches it.
// WHY the fake device: the probe proves the stop-and-restart container rule, which needs
// audio but not a person, a microphone or a TCC grant.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, ipcMain } from "electron";
import { createCaptureWindow } from "../../electron/captureWindow.mjs";
import { createMicController } from "../../electron/micController.mjs";
import { createMicSegmentWriter } from "../../electron/micSegments.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = process.env.PROBE_OUT;
const SEGMENT_SEC = Number(process.env.PROBE_SEGMENT_SEC ?? 3);
const WANT = 2;
const DEADLINE_MS = (SEGMENT_SEC * (WANT + 2) + 10) * 1000;

const rows = [];
const logs = [];
let states = [];

function finish(code, error) {
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ rows, states, logs, error }, null, 2));
  app.exit(code);
}

app.whenReady().then(async () => {
  const root = path.join(OUT, "media");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let resolveTwo;
  const two = new Promise((r) => (resolveTwo = r));
  const mic = createMicController({
    askMic: async () => true,
    createWindow: ({ onGone }) => createCaptureWindow({ page: { file: path.join(ROOT, "dist", "capture.html") }, onGone }),
    createWriter: () =>
      createMicSegmentWriter({
        root,
        addSegment: async (row) => {
          rows.push(row);
          if (rows.length >= WANT) resolveTwo();
        },
        log: (m) => logs.push(m),
      }),
    onState: (s) => states.push(s),
    recordError: (d) => logs.push(`capError: ${d}`),
    log: (m) => logs.push(m),
    micConfig: { segmentSec: SEGMENT_SEC, timesliceMs: 1000 },
  });
  ipcMain.on("gs:mic:event", (event, message) => mic.receive(event.sender, message));
  ipcMain.handle("gs:mic:config", (event) => mic.configFor(event.sender) ?? { ok: false, error: "Refused" });
  const timer = setTimeout(() => finish(2, `fewer than ${WANT} segments in ${DEADLINE_MS} ms`), DEADLINE_MS);
  await mic.start();
  await two;
  clearTimeout(timer);
  await mic.stop();
  states = states.map((s) => s.state);
  finish(0, null);
});
