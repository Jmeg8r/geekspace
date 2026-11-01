// WHAT: types for the call notice, so tests/ and the renderer can import them.

export const NOTICE_TIMEOUT_MS: number;
export const EXTEND_MS: number;

/** What the page shows: the question, a "not recorded" warning, or nothing. */
export type CallPrompt =
  | { state: "asking"; callId: string; app: string; deadline: number; canExtend: boolean }
  | { state: "timedOut" | "failed"; callId: string };

export type CallNotice = {
  callStarted: (app: string) => void;
  callEnded: () => void;
  given: (callId: string) => Promise<void>;
  declined: (callId: string) => Promise<void>;
  extend: (callId: string) => void;
  dismiss: () => void;
  recorderStopped: () => void;
  micHeld: () => boolean;
};

export function createCallNotice(options: {
  helper: { hold: () => void; release: (noticeEventId: string) => void; discard: () => void };
  logEvent: (event: { kind: "noticeGiven" | "noticeDeclined"; detail: string }) => Promise<string>;
  onPrompt: (prompt: CallPrompt | null) => void;
  onMicHeld: (held: boolean) => void;
  log: (message: string) => void;
}): CallNotice;
