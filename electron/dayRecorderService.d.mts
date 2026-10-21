// WHAT: types for the Day Recorder service, so tests/ can import it.
import type { CaptureSink, Supervisor, SupervisorOptions } from "./dayRecorder.mjs";
import type { GateResult } from "./dayRecorderGates.mjs";

export const SEGMENT_SEC: number;
export const PURGE_INTERVAL_MS: number;

/** The fields of dayRecorder.getSettings that reach the helper. */
export type RecorderSettings = { enabled: boolean; denylist: string[]; shotSec: number };

export type RecorderStatus =
  | { status: "off" | "starting" | "recording" | "stopping" | "unsupported" }
  | { status: "notRecording" | "blocked"; error: string };

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
