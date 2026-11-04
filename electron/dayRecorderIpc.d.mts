// WHAT: types for the Day Recorder's renderer controls, so tests/ can import them.
import type { CallPrompt } from "./callNotice.mjs";
import type { RecorderStatus } from "./dayRecorderService.mjs";

export const DAY_RECORDER_EVENT: "gs:dayRecorder:event";

/** What the windows receive on DAY_RECORDER_EVENT. */
export type DayRecorderEvent = { type: "status"; status: RecorderStatus } | { type: "call"; prompt: CallPrompt | null };

export type SettingsPatch = { enabled?: boolean; paused?: boolean };

export type DayRecorderControls = {
  setEnabled: (enabled: boolean) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
};

export function createDayRecorderControls(updateSettings: (patch: SettingsPatch) => Promise<void>): DayRecorderControls;

export type NoticeAnswers = {
  given: (callId: string) => Promise<void>;
  declined: (callId: string) => Promise<void>;
  extend: (callId: string) => void;
  dismiss: () => void;
};

export type ControllableRecorder = DayRecorderControls & {
  view: { status: () => RecorderStatus };
  notice: NoticeAnswers;
  callPrompt: () => CallPrompt | null;
};

/** What a page can send. setEnabled checks `enabled` itself, so a wrong type is refused there. */
export type ControlArgs = { enabled?: boolean | string | number | null | object; callId?: string | number | null | object };
export type ControlHandler = (args: ControlArgs) => RecorderStatus | CallPrompt | null | void | Promise<void>;

export function registerDayRecorderIpc(options: {
  handle: (channel: string, fn: ControlHandler) => void;
  recorder: () => ControllableRecorder | null;
}): void;

export type StatusWindow = {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, payload: DayRecorderEvent) => void };
};

export function forwardStatus(options: {
  service: { onStatus: (cb: (status: RecorderStatus) => void) => () => void };
  windows: () => StatusWindow[];
}): () => void;

export function forwardCallPrompt(options: {
  recorder: { onCallPrompt: (cb: (prompt: CallPrompt | null) => void) => () => void };
  windows: () => StatusWindow[];
}): () => void;
