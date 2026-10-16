// WHAT: Typed wrapper over the Electron meetings IPC bridge.

export interface MeetingToolStatus {
  ffmpeg: boolean;
  whisper: boolean;
  model: boolean;
  modelName: string;
}

export interface MeetingNotes {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  modelUsed: string;
}

/** Either the notes, or the transcript plus why the summary failed (the transcript is never lost). */
export type MeetingProcessResult =
  | (MeetingNotes & { transcript: string; summaryError?: undefined })
  | { transcript: string; summaryError: string };

export interface MeetingProgress {
  meetingId?: string;
  phase: "model" | "transcribing" | "summarizing";
  pct: number;
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface MeetingsBridge {
  tools(): Promise<IpcResult<MeetingToolStatus>>;
  ollama(url?: string): Promise<IpcResult<{ ok: boolean; models: string[]; error?: string }>>;
  askMic(): Promise<IpcResult<boolean>>;
  ensureModel(): Promise<IpcResult<boolean>>;
  process(payload: {
    meetingId: string;
    audio: ArrayBuffer;
    meetingType: string;
    ollamaUrl?: string;
    ollamaModel?: string;
  }): Promise<IpcResult<MeetingProcessResult>>;
  summarize(payload: {
    meetingId: string;
    transcript: string;
    meetingType: string;
    ollamaUrl?: string;
    ollamaModel?: string;
  }): Promise<IpcResult<MeetingProcessResult>>;
  onProgress(cb: (p: MeetingProgress) => void): () => void;
}

interface RecorderBridge {
  setActive(active: boolean): Promise<IpcResult<void>>;
  onSaveRequest(cb: () => void): () => void;
  saveDone(ok: boolean, error?: string): Promise<IpcResult<void>>;
}

// SAFETY: electron/preload.cjs exposes exactly these shapes on window.geekspace; in a
// browser tab it is undefined, which every caller handles through optional chaining.
type GeekspaceWindow = { geekspace?: { meetings?: MeetingsBridge; recorder?: RecorderBridge } };

function bridge(): MeetingsBridge | undefined {
  return (window as GeekspaceWindow).geekspace?.meetings;
}

function recorderBridge(): RecorderBridge | undefined {
  return (window as GeekspaceWindow).geekspace?.recorder;
}

export const meetingsAvailable = (): boolean => Boolean(bridge());

async function call<T>(fn: (b: MeetingsBridge) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const b = bridge();
  if (!b) return { ok: false, error: "Meeting notes need the desktop app" };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

export const meetingTools = () => call((b) => b.tools());
export const meetingOllama = (url?: string) => call((b) => b.ollama(url));
export const meetingAskMic = () => call((b) => b.askMic());
export const meetingEnsureModel = () => call((b) => b.ensureModel());
export const meetingProcess = (payload: Parameters<MeetingsBridge["process"]>[0]) =>
  call((b) => b.process(payload));
export const meetingSummarize = (payload: Parameters<MeetingsBridge["summarize"]>[0]) =>
  call((b) => b.summarize(payload));

/** Quit guard: tell the main process whether a recording is live. */
export const reportRecordingActive = (active: boolean): void => {
  void recorderBridge()
    ?.setActive(active)
    .catch((err) => console.warn("Could not report recording state to the quit guard", err));
};

/** Quit guard: answer the main process's "save before quitting" request. */
export const onSaveRecordingRequest = (save: () => Promise<void>): (() => void) => {
  const b = recorderBridge();
  if (!b) return () => {};
  return b.onSaveRequest(() => {
    save().then(
      () => b.saveDone(true),
      (err) => b.saveDone(false, String((err as Error)?.message ?? err))
    );
  });
};

export const onMeetingProgress = (cb: (p: MeetingProgress) => void): (() => void) => {
  const b = bridge();
  if (!b) return () => {};
  return b.onProgress(cb);
};
