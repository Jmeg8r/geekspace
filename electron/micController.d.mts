// WHAT: types for the mic capture controller, so tests/ can import it.
import type { IncomingMessage, MicSegmentWriter } from "./micSegments.mjs";

export type MicState =
  | { state: "off" | "starting" | "ok" }
  | { state: "silent"; silentSec: number }
  | { state: "error"; kind: string; error: string };

export type CaptureWindow = {
  webContents: { id: number; send: (channel: string) => void };
  destroy: () => void;
  isDestroyed: () => boolean;
};

export type MicConfig = { segmentSec: number; timesliceMs: number };

export type ConfigReply = { ok: true; data: MicConfig } | { ok: false; cancelled: true; error: string };

export type MicController = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** A call started: drop the open segment unfinished, then stop. */
  discard: () => Promise<void>;
  receive: (sender: { id: number } | null | undefined, message: IncomingMessage) => void;
  ownsSender: (sender: { id: number } | null | undefined) => boolean;
  /** The capture page's config: cancelled when a stop came first; null for another sender. */
  configFor: (sender: { id: number } | null | undefined) => ConfigReply | null;
  /** Quit: stop for good; no later start opens anything. */
  shutdown: () => Promise<void>;
  state: () => MicState;
  isCaptureWindow: (win: object) => boolean;
};

export function createMicController(options: {
  askMic: () => Promise<boolean>;
  createWindow: (hooks: { onGone: () => void }) => CaptureWindow;
  createWriter: () => Pick<MicSegmentWriter, "handle" | "drain" | "close">;
  onState: (state: MicState) => void;
  recordError: (detail: string) => void;
  log: (message: string) => void;
  micConfig: MicConfig;
  stopTimeoutMs?: number;
}): MicController;
