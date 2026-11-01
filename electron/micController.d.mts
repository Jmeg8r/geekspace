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

export type MicController = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  receive: (sender: { id: number } | null | undefined, message: IncomingMessage) => void;
  ownsSender: (sender: { id: number } | null | undefined) => boolean;
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
  stopTimeoutMs?: number;
}): MicController;
