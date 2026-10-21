// WHAT: types for the Day Recorder service, so tests/ can import it.
import type { CaptureSink, Supervisor, SupervisorOptions } from "./dayRecorder.mjs";
import type { GateResult } from "./dayRecorderGates.mjs";

export const SEGMENT_SEC: number;
export const PURGE_INTERVAL_MS: number;
export const RETRY_DELAYS_MS: number[];
export const RETRY_RESET_MS: number;

/** The fields of dayRecorder.getSettings that reach the helper. */
export type RecorderSettings = { enabled: boolean; denylist: string[]; shotSec: number };

export type RecorderStatus =
  | { status: "off" | "starting" | "recording" | "stopping" | "unsupported" }
  | { status: "blocked"; error: string }
  /** `retryInMs` is set while an automatic retry is pending. */
  | { status: "notRecording"; error: string; retryInMs?: number };

export type ServiceOptions = {
  platform: NodeJS.Platform;
  mediaRoot: string;
  helperPath: string;
  gates: {
    fileVault: () => Promise<GateResult>;
    backupExclusion: (root: string) => Promise<GateResult>;
  };
  createSupervisor: (options: SupervisorOptions) => Supervisor;
  convex: CaptureSink & {
    logEvent: (event: { kind: "capError"; detail: string }) => Promise<void>;
  };
  purge: () => Promise<void>;
  log: (message: string) => void;
  purgeIntervalMs?: number;
  retryDelaysMs?: number[];
  retryResetMs?: number;
};

export type DayRecorderService = {
  apply: (settings: RecorderSettings) => Promise<void>;
  shutdown: () => Promise<void>;
  status: () => RecorderStatus;
  onStatus: (cb: (status: RecorderStatus) => void) => () => void;
  running: () => boolean;
  killSync: () => void;
};

export function createDayRecorderService(options: ServiceOptions): DayRecorderService;

export function createQuitHold(options: {
  stop: () => Promise<void>;
  quit: () => void;
  log: (message: string) => void;
}): (event: { preventDefault: () => void }) => boolean;
