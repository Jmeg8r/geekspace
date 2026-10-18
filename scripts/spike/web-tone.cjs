// WHAT: Electron main for the Day Recorder spike: plays a WebAudio tone (and optionally
// opens the fake mic) for GS_TONE_SECONDS from a small visible window.
// WHY: Chromium renders audio in a helper process, not the app process a denylist names.
// This checks that excluding the app's bundle ID also drops helper audio from SCK, and that
// CoreAudio maps the helper back to the app, using Electron as a stand-in for any browser.
// Run via `node scripts/spike-day-recorder.mjs web-audio`, not directly.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SECONDS = Number(process.env.GS_TONE_SECONDS ?? 6);
const WINDOW_SIZE = 240;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// GS_TONE_REAL_MIC=1 opens the real default mic (one TCC prompt), to see which Chromium
// process CoreAudio reports as holding it; otherwise Chromium's fake device is used.
if (process.env.GS_TONE_REAL_MIC !== "1") app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: WINDOW_SIZE, height: WINDOW_SIZE, title: "SYNTHETIC web tone" });
    const page = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gs-web-tone-")), "tone.html");
    fs.writeFileSync(page, "<!doctype html><title>SYNTHETIC web tone</title>");
    await win.loadFile(page);
    const started = await win.webContents.executeJavaScript(`(async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.25;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      await ctx.resume();
      ${process.env.GS_TONE_MIC === "1" || process.env.GS_TONE_REAL_MIC === "1" ? "window.mic = await navigator.mediaDevices.getUserMedia({ audio: true });" : ""}
      return Date.now();
    })()`);
    console.log(JSON.stringify({ event: "started", t: started, pid: process.pid }));
    setTimeout(() => app.exit(0), SECONDS * 1000);
  } catch (error) {
    console.error(`web-tone failed: ${error.stack ?? error}`);
    app.exit(1);
  }
});
