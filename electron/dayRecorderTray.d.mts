// WHAT: types for the Day Recorder's menu-bar indicator and pause shortcut, so tests/ can import them.
import type { RecorderStatus } from "./dayRecorderService.mjs";

/** How long an `off` straight after `stopping` or `notRecording` is held back. */
export const OFF_HOLD_MS: number;
export const PAUSE_ACCELERATOR: "Alt+Command+R";
/** Appended to every tooltip while another app holds ⌥⌘R. */
export const SHORTCUT_TAKEN: string;

export type StatusSource = {
  status: () => RecorderStatus;
  onStatus: (cb: (status: RecorderStatus) => void) => () => void;
};

export type StatusView = StatusSource & { stop: () => void };

/** The status the windows and the tray show: the service's, without the passing `off`. */
export function createStatusView(source: StatusSource): StatusView;

export type Tone = "red" | "amber" | "grey" | "hollow";

export type TrayView = { tone: Tone; title: string; tooltip: string; action: "pause" | "resume" };

/** What the menu bar shows for a status; null means no tray at all. */
export function trayView(status: RecorderStatus, options: { shortcut: boolean }): TrayView | null;

/** A square RGBA PNG of the tone's dot. */
export function dotPng(tone: Tone, sizePx: number): Buffer;

export type TrayImage = { setTemplateImage: (on: boolean) => void };

export function trayImage<Image extends TrayImage>(
  nativeImage: { createFromBuffer: (png: Buffer, options: { scaleFactor: number }) => Image },
  tone: Tone
): Image;

export type MenuItem =
  | { type: "separator" }
  | { label: string; enabled?: boolean; accelerator?: string; registerAccelerator?: boolean; click?: () => void };

export type TrayLike<Image, Menu> = {
  setImage: (image: Image) => void;
  setTitle: (title: string) => void;
  setToolTip: (tooltip: string) => void;
  setContextMenu: (menu: Menu) => void;
  destroy: () => void;
};

export type IndicatorControls = {
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
};

export function startRecorderIndicator<Image, Menu>(options: {
  view: StatusSource;
  platform: string;
  createTray: (image: Image) => TrayLike<Image, Menu>;
  buildMenu: (items: MenuItem[]) => Menu;
  createImage: (tone: Tone) => Image;
  globalShortcut: { register: (accelerator: string, cb: () => void) => boolean; unregister: (accelerator: string) => void };
  controls: IndicatorControls;
  showApp: () => void;
  log: (message: string) => void;
}): { stop: () => void };
