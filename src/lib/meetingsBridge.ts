// WHAT: Typed wrapper over the Electron meetings IPC bridge.

export interface MeetingToolStatus {
  ffmpeg: boolean;
  whisper: boolean;
  model: boolean;
  modelName: string;
}

export interface MeetingProcessResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  modelUsed: string;
}

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
  onProgress(cb: (p: MeetingProgress) => void): () => void;
}

function bridge(): MeetingsBridge | undefined {
  return (window as { geekspace?: { meetings?: MeetingsBridge } }).geekspace?.meetings;
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
export const onMeetingProgress = (cb: (p: MeetingProgress) => void): (() => void) => {
  const b = bridge();
  if (!b) return () => {};
  return b.onProgress(cb);
};
