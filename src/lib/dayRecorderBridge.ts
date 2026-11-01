// WHAT: typed wrapper over the Day Recorder's renderer controls (window.geekspace.dayRecorder,
// electron/preload.cjs and dayRecorderIpc.mjs). WHY: every IPC failure comes back as an
// error result the UI can show, never a thrown promise.
import type { RecorderStatus } from "../../electron/dayRecorderService.mjs";

export type { RecorderStatus };

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

type RecorderEvent = { type: "status"; status: RecorderStatus } | { type: string; status?: undefined };

interface DayRecorderBridge {
  status(): Promise<IpcResult<RecorderStatus>>;
  setEnabled(enabled: boolean): Promise<IpcResult<void>>;
  pause(): Promise<IpcResult<void>>;
  resume(): Promise<IpcResult<void>>;
  onEvent(cb: (event: RecorderEvent) => void): () => void;
}

// SAFETY: electron/preload.cjs exposes exactly this shape on window.geekspace.dayRecorder; in
// a browser tab it is undefined, which every caller handles.
type GeekspaceWindow = { geekspace?: { dayRecorder?: DayRecorderBridge } };

function bridge(): DayRecorderBridge | undefined {
  // SAFETY: see GeekspaceWindow; a missing namespace reads as undefined.
  return (window as GeekspaceWindow).geekspace?.dayRecorder;
}

export const dayRecorderAvailable = (): boolean => Boolean(bridge());

async function call<T>(fn: (b: DayRecorderBridge) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const b = bridge();
  if (!b) return { ok: false, error: "The Day Recorder needs the desktop app." };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const recorderStatus = () => call((b) => b.status());
export const setRecorderEnabled = (enabled: boolean) => call((b) => b.setEnabled(enabled));
export const pauseRecorder = () => call((b) => b.pause());
export const resumeRecorder = () => call((b) => b.resume());

/** Follow the recorder's status. Returns the unsubscribe. */
export function onRecorderStatus(cb: (status: RecorderStatus) => void): () => void {
  const b = bridge();
  if (!b) return () => {};
  return b.onEvent((event) => {
    if (event.type === "status" && event.status) cb(event.status);
  });
}
