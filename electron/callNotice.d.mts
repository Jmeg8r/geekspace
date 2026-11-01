// WHAT: types for the call notice, so tests/ and the renderer can import them.
import type { RecorderStatus } from "./dayRecorderService.mjs";

export const NOTICE_TIMEOUT_MS: number;
export const EXTEND_MS: number;

/** What the page shows: the question, a "not recorded" warning, or nothing. */
export type CallPrompt =
  | { state: "asking"; callId: string; app: string; deadline: number; canExtend: boolean }
  | { state: "timedOut" | "failed"; callId: string };

export type CallNotice = {
  /** A new helper is starting: always true (it starts held); the old helper's calls are gone. */
  helperStarting: () => boolean;
  /** The helper stopped: its calls are gone with it. */
  helperGone: () => void;
  /** The helper's first audio-use report is in. */
  audioReady: () => void;
  callAppStarted: (app: string) => void;
  callEnded: () => void;
  given: (callId: string) => Promise<void>;
  declined: (callId: string) => Promise<void>;
  extend: (callId: string) => void;
  dismiss: () => void;
  micHeld: () => boolean;
};

export function createCallNotice(options: {
  helper: { hold: () => void; release: (noticeEventId: string) => void; discard: () => void; clear: () => void };
  logEvent: (event: { kind: "noticeGiven" | "noticeDeclined"; detail: string }) => Promise<string>;
  onPrompt: (prompt: CallPrompt | null) => void;
  onMicHeld: (held: boolean) => void;
  log: (message: string) => void;
}): CallNotice;

export function statusWithCall(status: RecorderStatus, prompt: CallPrompt | null): RecorderStatus;
