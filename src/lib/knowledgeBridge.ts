// WHAT: Typed renderer wrapper for the Enterprise Search IPC bridge.

export interface KnowledgeResult {
  title: string;
  section?: string;
  url?: string;
  score: number;
  snippet: string;
}

export interface KnowledgeSearchData {
  results: KnowledgeResult[];
  rateInfo?: string;
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface KnowledgeBridge {
  search(query: string, limit?: number): Promise<IpcResult<KnowledgeSearchData>>;
  answer(question: string): Promise<IpcResult<string>>;
  openExternal(url: string): Promise<IpcResult<void>>;
}

function bridge(): KnowledgeBridge | undefined {
  return (window as { geekspace?: { knowledge?: KnowledgeBridge } }).geekspace?.knowledge;
}

export const knowledgeAvailable = (): boolean => Boolean(bridge());

async function call<T>(fn: (b: KnowledgeBridge) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const b = bridge();
  if (!b) return { ok: false, error: "Knowledge search needs the desktop app" };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

export const knowledgeSearch = (query: string, limit = 5) =>
  call((b) => b.search(query, limit));
export const knowledgeAnswer = (question: string) => call((b) => b.answer(question));
export const openExternalUrl = (url: string) => call((b) => b.openExternal(url));
