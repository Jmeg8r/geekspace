// WHAT: types for the Day Recorder service, so tests/ can import it.
import type { CaptureSink, HelperMessage, Supervisor, SupervisorOptions } from "./dayRecorder.mjs";
import type { GateResult } from "./dayRecorderGates.mjs";
import type { MicState } from "./micController.mjs";

export const SEGMENT_SEC: number;
export const PURGE_INTERVAL_MS: number;
export const RETRY_DELAYS_MS: number[];
export const RETRY_RESET_MS: number;

/** The fields of dayRecorder.getSettings that reach the helper. */
export type RecorderSettings = { enabled: boolean; paused: boolean; denylist: string[]; shotSec: number };

export type RecorderStatus =
  | { status: "off" | "paused" | "starting" | "stopping" | "unsupported" }
  /** `mic` is the mic's own state once it has one (micController.mjs). */
  /** `call: "held"` while a call waits for its notice (plan PR 4b). */
  | { status: "recording"; mic?: MicState; call?: "held" }
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
  /** Asked as each helper starts: hold call audio from its first sample (plan PR 4b). */
  callHeldAtStart?: () => boolean;
  /** Runs before a helper is stopped, while it is still the current one. */
  beforeHelperStop?: () => Promise<void>;
};

export type DayRecorderService = {
  apply: (settings: RecorderSettings) => Promise<void>;
  shutdown: () => Promise<void>;
  status: () => RecorderStatus;
  setMic: (mic: MicState) => void;
  onStatus: (cb: (status: RecorderStatus) => void) => () => void;
  onAudioUse: (cb: (message: Extract<HelperMessage, { event: "audioUse" }>) => void) => () => void;
  /** The call hold on the live helper; each throws when no helper is running. */
  calls: { hold: () => void; release: (noticeEventId: string) => void; discard: () => void; clear: () => void };
  onAudioUseReady: (cb: () => void) => () => void;
  onCallHeld: (cb: (app: string) => void) => () => void;
  onAudioClassified: (cb: (through: number) => void) => () => void;
  onAudioGap: (cb: (from: number, to: number) => void) => () => void;
  running: () => boolean;
  killSync: () => void;
};

export function createDayRecorderService(options: ServiceOptions): DayRecorderService;

export function createQuitHold(options: {
  stop: () => Promise<void>;
  quit: () => void;
  log: (message: string) => void;
}): (event: { preventDefault: () => void }) => boolean;
