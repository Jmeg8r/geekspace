// WHAT: the page's side of the Day Recorder assistant's API key (plan PR 6a, spec F4) and of
// Linear drafts (plan PR 6b, spec R12). A key goes in, and nothing brings it back: the page can
// only ask whether one is saved. A Linear draft is sent only by approving it, by id. A
// screenshot's image is sent only when asked for by id (spec R9), and the day's summary only
// when asked for (plan PR 6c, spec R13).
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface KeyBridge {
  setApiKey(key: string): Promise<IpcResult<void>>;
  hasApiKey(): Promise<IpcResult<boolean>>;
  clearApiKey(): Promise<IpcResult<void>>;
}

/** What came of an assistant request, in words for the page (electron/dayAssistant.mjs). */
export type ImageResult = { ok: true; actions: number } | { ok: false; reason: string };
export type SummaryResult = { ok: true; items: number } | { ok: false; reason: string };

interface AssistantBridge extends KeyBridge {
  requestImage(screenshotId: string): Promise<IpcResult<ImageResult>>;
  summarize(day: string, from: number, to: number): Promise<IpcResult<SummaryResult>>;
}

interface LinearBridge extends KeyBridge {
  approve(draftId: string): Promise<IpcResult<void>>;
}

// SAFETY: electron/preload.cjs exposes exactly these shapes on window.geekspace.assistant and
// .linear; in a browser tab they are undefined, which every caller handles.
type GeekspaceWindow = { geekspace?: { assistant?: AssistantBridge; linear?: LinearBridge } };

// SAFETY: see GeekspaceWindow; a missing namespace reads as undefined.
const namespaces = () => (window as GeekspaceWindow).geekspace;

export const assistantAvailable = (): boolean => Boolean(namespaces()?.assistant);

async function call<B, T>(b: B | undefined, missing: string, fn: (b: B) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  if (!b) return { ok: false, error: missing };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const assistant = <T>(fn: (b: AssistantBridge) => Promise<IpcResult<T>>) =>
  call(namespaces()?.assistant, "The assistant needs the desktop app.", fn);
const linear = <T>(fn: (b: LinearBridge) => Promise<IpcResult<T>>) => call(namespaces()?.linear, "Linear needs the desktop app.", fn);

export const hasApiKey = () => assistant((b) => b.hasApiKey());
export const saveApiKey = (key: string) => assistant((b) => b.setApiKey(key.trim()));
export const clearApiKey = () => assistant((b) => b.clearApiKey());
export const requestImage = (screenshotId: string) => assistant((b) => b.requestImage(screenshotId));
export const summarizeDay = (day: string, from: number, to: number) => assistant((b) => b.summarize(day, from, to));

export const hasLinearKey = () => linear((b) => b.hasApiKey());
export const saveLinearKey = (key: string) => linear((b) => b.setApiKey(key.trim()));
export const clearLinearKey = () => linear((b) => b.clearApiKey());
export const approveDraft = (draftId: string) => linear((b) => b.approve(draftId));
