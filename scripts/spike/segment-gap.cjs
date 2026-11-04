// WHAT: Electron main for the Day Recorder spike's R2 measurement: records N segments by
// stopping and restarting MediaRecorder on ONE MediaStream, and writes each segment out.
// WHY: spec R2 requires every segment to decode on its own, which means stop + restart at
// each boundary; this measures the audio lost at each restart, for two restart strategies.
// Chromium's fake capture device stands in for the mic: the stream is opened once either
// way, so the restart cost does not depend on the device, and no TCC prompt is needed.
// Run via `node scripts/spike-day-recorder.mjs segment-gap`, not directly.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = process.env.GS_SEGMENT_DIR;
const SEGMENTS = Number(process.env.GS_SEGMENTS ?? 6);
const SEGMENT_MS = Number(process.env.GS_SEGMENT_MS ?? 5000);
const TIMESLICE_MS = 1000;

app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

// Runs in the renderer. `overlap` starts the next recorder before the old one has
// finished stopping; `sequential` waits for the old recorder's stop event.
const RENDERER = (segments, segmentMs, timesliceMs, strategy) => `(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = "audio/webm;codecs=opus";
  const results = [];
  const record = () => new Promise((resolveStarted) => {
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    const entry = { chunks: 0 };
    rec.ondataavailable = (e) => { if (e.data.size) { chunks.push(e.data); entry.chunks += 1; } };
    entry.stopped = new Promise((resolve) => {
      rec.onstop = async () => {
        entry.onstopAt = performance.now();
        entry.bytes = Array.from(new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer()));
        resolve();
      };
    });
    rec.onstart = () => { entry.onstartAt = performance.now(); resolveStarted({ rec, entry }); };
    rec.start(${timesliceMs});
  });
  let current = await record();
  for (let i = 0; i < ${segments}; i += 1) {
    await new Promise((r) => setTimeout(r, ${segmentMs}));
    const previous = current;
    previous.entry.stopCalledAt = performance.now();
    previous.rec.stop();
    results.push(previous.entry);
    if (i === ${segments} - 1) break;
    if ("${strategy}" === "sequential") await previous.entry.stopped;
    current = await record();
  }
  await Promise.all(results.map((r) => r.stopped));
  stream.getTracks().forEach((t) => t.stop());
  return results.map(({ stopped, ...rest }) => rest);
})()`;

app.whenReady().then(async () => {
  try {
    if (!OUT_DIR) throw new Error("GS_SEGMENT_DIR is not set");
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    // A data: URL is not a secure context, so it has no navigator.mediaDevices.
    const page = path.join(OUT_DIR, "segment-gap.html");
    fs.writeFileSync(page, "<!doctype html><title>segment-gap</title>");
    await win.loadFile(page);
    const summary = {};
    for (const strategy of ["overlap", "sequential"]) {
      const segments = await win.webContents.executeJavaScript(RENDERER(SEGMENTS, SEGMENT_MS, TIMESLICE_MS, strategy));
      const dir = path.join(OUT_DIR, strategy);
      fs.mkdirSync(dir, { recursive: true });
      summary[strategy] = segments.map((segment, index) => {
        const file = path.join(dir, `segment-${index + 1}.webm`);
        fs.writeFileSync(file, Buffer.from(segment.bytes));
        return { file, chunks: segment.chunks, bytes: segment.bytes.length, onstartAt: segment.onstartAt,
          stopCalledAt: segment.stopCalledAt, onstopAt: segment.onstopAt };
      });
    }
    fs.writeFileSync(path.join(OUT_DIR, "segments.json"), JSON.stringify(summary, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(`segment-gap failed: ${error.stack ?? error}`);
    app.exit(1);
  }
});
