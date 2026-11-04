// WHAT: the Day Recorder's menu-bar indicator and its ⌥⌘R pause shortcut (plan PR 3e-1),
// and the status view that both it and the app windows show.
// WHY a status view: the service passes through `off` on its way from `stopping` to
// `paused`, and from `notRecording` to a retry's `starting` (plan.md, 3c part 2 and 3d-1),
// each time within a millisecond. Shown as it comes, the menu bar would flash "Off" while
// nothing was turned off. The view holds that `off` back briefly; a real one still shows.
// WHY Electron is passed in: so the tests drive the tray and the shortcut with fakes.
import { crc32, deflateSync } from "node:zlib";
import { statusCopy } from "./dayRecorderCopy.mjs";

// The measured gaps are 0–1 ms (status lines in ~/gs-part2-evidence), so this is ample,
// and a real `off` shows this much later at worst.
export const OFF_HOLD_MS = 250;
export const PAUSE_ACCELERATOR = "Alt+Command+R";

/** The status the windows and the tray show: the service's, without the passing `off`. */
export function createStatusView(source) {
  let current = source.status();
  let lastRaw = current;
  let held = null;
  const listeners = new Set();

  const show = (status) => {
    if (JSON.stringify(status) === JSON.stringify(current)) return;
    current = status;
    for (const cb of listeners) cb(status);
  };
  const release = () => {
    clearTimeout(held);
    held = null;
  };

  const unsubscribe = source.onStatus((status) => {
    const previous = lastRaw;
    lastRaw = status;
    if (status.status === "off" && held) return;
    release();
    if (status.status === "off" && (previous.status === "stopping" || previous.status === "notRecording")) {
      held = setTimeout(() => {
        held = null;
        show(status);
      }, OFF_HOLD_MS);
      return;
    }
    show(status);
  });

  return {
    status: () => current,
    onStatus(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    stop() {
      unsubscribe();
      release();
      listeners.clear();
    },
  };
}

// The state copy lives in dayRecorderCopy.mjs, shared with the app (plan PR 3e-2).
export { SHORTCUT_TAKEN, statusCopy as trayView } from "./dayRecorderCopy.mjs";

// Red and amber keep 3:1 against both a light and a dark menu bar (WCAG 1.4.11). Grey and
// hollow are black template images, which macOS tints to suit the menu bar.
const TONES = {
  red: { rgb: [0xd9, 0x30, 0x36], ring: false },
  amber: { rgb: [0xc2, 0x7c, 0x0e], ring: false },
  grey: { rgb: [0, 0, 0], ring: false },
  hollow: { rgb: [0, 0, 0], ring: true },
};
const TEMPLATE_TONES = new Set(["grey", "hollow"]);
const DOT_RADIUS = 0.3;
const RING_WIDTH = 0.1;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const clamp01 = (n) => Math.min(1, Math.max(0, n));

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A square RGBA PNG of the tone's dot, edges anti-aliased by coverage. */
export function dotPng(tone, sizePx) {
  const { rgb, ring } = TONES[tone];
  const centre = sizePx / 2;
  const radius = sizePx * DOT_RADIUS;
  const inner = radius - sizePx * RING_WIDTH;
  const rowBytes = sizePx * 4 + 1;
  const raw = Buffer.alloc(rowBytes * sizePx);
  for (let y = 0; y < sizePx; y++) {
    for (let x = 0; x < sizePx; x++) {
      const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      let cover = clamp01(radius + 0.5 - d);
      if (ring) cover *= clamp01(d - inner + 0.5);
      const at = y * rowBytes + 1 + x * 4;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
      raw[at + 3] = Math.round(cover * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(sizePx, 0);
  header.writeUInt32BE(sizePx, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// A 16 pt menu-bar icon, drawn at 2x for Retina.
const ICON_SCALE = 2;
const ICON_PX = 16 * ICON_SCALE;

export function trayImage(nativeImage, tone) {
  const image = nativeImage.createFromBuffer(dotPng(tone, ICON_PX), { scaleFactor: ICON_SCALE });
  if (TEMPLATE_TONES.has(tone)) image.setTemplateImage(true);
  return image;
}

/**
 * Show the view in the menu bar while the recorder is on, and own ⌥⌘R while it is.
 * macOS only, like the recorder itself. Returns a handle main stops on quit.
 */
export function startRecorderIndicator({ view, platform, createTray, buildMenu, createImage, globalShortcut, controls, showApp, log }) {
  if (platform !== "darwin") return { stop() {} };
  let tray = null;
  let tone = null;
  // null: not tried since the tray appeared; then whether the register call succeeded.
  let shortcut = null;

  const run = (what, fn) => {
    fn().catch((err) => log(`menu bar: could not ${what} (${err?.message ?? err})`));
  };
  const toggle = () => (view.status().status === "paused" ? run("resume", controls.resume) : run("pause", controls.pause));

  const teardown = () => {
    if (shortcut) globalShortcut.unregister(PAUSE_ACCELERATOR);
    shortcut = null;
    tray?.destroy();
    tray = null;
    tone = null;
  };

  const render = (status) => {
    if (!statusCopy(status, { shortcut: true })) {
      teardown();
      return;
    }
    if (shortcut === null) {
      shortcut = globalShortcut.register(PAUSE_ACCELERATOR, toggle);
      if (!shortcut) log("menu bar: ⌥⌘R is in use by another app, so pause and resume are in the menu only");
    }
    const v = statusCopy(status, { shortcut });
    if (!tray) tray = createTray(createImage(v.tone));
    else if (v.tone !== tone) tray.setImage(createImage(v.tone));
    tone = v.tone;
    tray.setTitle(v.title);
    tray.setToolTip(v.tooltip);
    const act =
      v.action === "resume"
        ? { label: "Resume recording", click: () => run("resume", controls.resume) }
        : { label: "Pause recording", click: () => run("pause", controls.pause) };
    tray.setContextMenu(
      buildMenu([
        { label: v.title, enabled: false },
        { type: "separator" },
        shortcut ? { ...act, accelerator: PAUSE_ACCELERATOR, registerAccelerator: false } : act,
        { label: "Open Geekspace", click: showApp },
        { type: "separator" },
        { label: "Turn off Day Recorder", click: () => run("turn the recorder off", () => controls.setEnabled(false)) },
      ])
    );
  };

  render(view.status());
  const unsubscribe = view.onStatus(render);
  return {
    stop() {
      unsubscribe();
      teardown();
    },
  };
}
