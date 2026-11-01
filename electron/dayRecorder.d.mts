// WHAT: types for the Day Recorder supervisor, so tests/ can import it (see meetingProcessor.d.mts).
import type { ChildProcess, SpawnOptions } from "node:child_process";

export const PROTOCOL_VERSION: 1;
export const SILENT_LIMIT_MS: number;
export const STOP_GRACE_MS: number;
export const DRAIN_MS: number;
export const AUDIO_USE_READY_LIMIT_MS: number;

/** The Convex client's logger shape. */
export type ClientLogger = {
  log: (...args: unknown[]) => void;
  logVerbose: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
export function createFileLog(
  file: string,
  fallback?: (message: string) => void
): { log: (message: string) => void; end: () => void };
export function contentFreeLogger(log: (message: string) => void): ClientLogger;

/** One protocol v1 line. Only the fields the supervisor reads are typed. */
export type HelperMessage =
  | { v: 1; event: "ready"; pid: number }
  | { v: 1; event: "heartbeat"; t: number }
  | { v: 1; event: "shot"; day: string; path: string; takenAt: number; appBundleId: string | null; ocrText: string }
  | { v: 1; event: "segment"; kind: "system" | "call"; day: string; path: string; start: number; end: number }
  | { v: 1; event: "callHeld"; t: number; app?: string }
  | { v: 1; event: "callReleased"; segments: number; heldSec: number; overflowed: boolean }
  | { v: 1; event: "callDiscarded"; heldSec: number; reason: "command" | "stop" }
  | { v: 1; event: "callCleared"; segments: number; heldSec: number }
  | { v: 1; event: "audioUseReady"; t: number; apps: number }
  | { v: 1; event: "audioUse"; app: string | null; denylisted: boolean; input: boolean; output: boolean }
  | { v: 1; event: "stopped"; reason: string }
  | { v: 1; event: "tapRebuilt" | "tailDropped" | "sampleRateChanged" | "sessionUnverified" };

export function parseLine(text: string): { ok: true; message: HelperMessage } | { ok: false; reason: string };

/** The arguments of dayRecorder.addScreenshot. */
export type ScreenshotRow = { day: string; path: string; takenAt: number; appBundleId?: string; ocrText: string };
/** The arguments of dayRecorder.addSegment, as the helper produces them. */
export type SegmentRow =
  | { day: string; kind: "system"; path: string; start: number; end: number }
  /** Call audio carries the notice event that released it (spec R5). */
  | { day: string; kind: "call"; path: string; start: number; end: number; noticeEventId: string };

export type CaptureSink = {
  addScreenshot: (row: ScreenshotRow) => Promise<void>;
  addSegment: (row: SegmentRow) => Promise<void>;
};

export type CaptureError = {
  reason: "spawnFailed" | "exited" | "silent" | "protocol";
  message: string;
  code?: number | null;
};

export type SupervisorState =
  | { status: "off" | "starting" | "recording" | "stopping" }
  | { status: "notRecording"; error: CaptureError };

export type SupervisorOptions = {
  command: string;
  prefixArgs?: string[];
  mediaRoot: string;
  sink: CaptureSink;
  log: (message: string) => void;
  onState: (state: SupervisorState) => void;
  /** Each audioUse line, as parsed (plan PR 4b). */
  onAudioUse?: (message: Extract<HelperMessage, { event: "audioUse" }>) => void;
  /** The helper's first audio-use report is in (plan PR 4b). */
  onAudioUseReady?: () => void;
  /** The helper held a call app's audio on its own: the app it saw start. */
  onCallHeld?: (app: string) => void;
  /** The apps the helper treats as calls; callDetector.mjs's lists by default. */
  calls?: { apps: string[]; browsers: string[] };
  env?: NodeJS.ProcessEnv;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  silentLimitMs?: number;
  stopGraceMs?: number;
  drainMs?: number;
  /** How long after ready the first audio-use report may take. */
  audioUseReadyLimitMs?: number;
};

/** `startHeld`: the helper holds call audio from its first sample (plan PR 4b). */
export type StartOptions = { denylist: string[]; shotSec: number; segmentSec: number; startHeld?: boolean };

export type Supervisor = {
  start: (options: StartOptions) => void;
  stop: () => Promise<void>;
  /** Throws when no helper is running. */
  holdCall: () => void;
  releaseCall: (noticeEventId: string) => void;
  discardCall: () => void;
  clearCall: () => void;
  state: () => SupervisorState;
  running: () => boolean;
  killSync: () => void;
};

export function createSupervisor(options: SupervisorOptions): Supervisor;
