// WHAT: the page's side of the Day Recorder assistant's API key (plan PR 6a, spec F4). The key
// goes in, and nothing brings it back: the page can only ask whether one is saved.
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface AssistantBridge {
  setApiKey(key: string): Promise<IpcResult<void>>;
  hasApiKey(): Promise<IpcResult<boolean>>;
  clearApiKey(): Promise<IpcResult<void>>;
}

// SAFETY: electron/preload.cjs exposes exactly this shape on window.geekspace.assistant; in a
// browser tab it is undefined, which every caller handles.
type GeekspaceWindow = { geekspace?: { assistant?: AssistantBridge } };

function bridge(): AssistantBridge | undefined {
  // SAFETY: see GeekspaceWindow; a missing namespace reads as undefined.
  return (window as GeekspaceWindow).geekspace?.assistant;
}

export const assistantAvailable = (): boolean => Boolean(bridge());

async function call<T>(fn: (b: AssistantBridge) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const b = bridge();
  if (!b) return { ok: false, error: "The assistant needs the desktop app." };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const hasApiKey = () => call((b) => b.hasApiKey());
export const saveApiKey = (key: string) => call((b) => b.setApiKey(key.trim()));
export const clearApiKey = () => call((b) => b.clearApiKey());
