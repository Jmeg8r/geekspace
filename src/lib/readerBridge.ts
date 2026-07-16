// WHAT: Typed renderer wrapper for the aib-reader RSS IPC bridge. Mirrors
// knowledgeBridge.ts. Interfaces match aib-reader's Feed/Item/PollSummary as
// serialized by model_dump(mode="json") / dataclasses.asdict.

export interface Feed {
  id: string;
  url: string;
  title: string | null;
  site_url: string | null;
  categories: string[];
  active: boolean;
  last_fetched_at: string | null;
  etag: string | null;
  modified: string | null;
}

export interface Item {
  id: string;
  feed_id: string;
  feed_title: string | null;
  url: string | null;
  canonical_url: string | null;
  title: string | null;
  summary: string | null;
  author: string | null;
  guid: string | null;
  published_at: string | null;
  fetched_at: string | null;
  categories: string[];
}

export interface PollSummary {
  feeds_polled: number;
  feeds_failed: number;
  new_items: number;
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface ReaderBridge {
  listFeeds(): Promise<IpcResult<Feed[]>>;
  recentItems(limit?: number, since?: string, category?: string): Promise<IpcResult<Item[]>>;
  searchItems(query: string, limit?: number): Promise<IpcResult<Item[]>>;
  markProcessed(itemIds: string[], consumer: string): Promise<IpcResult<number>>;
  addFeed(url: string, category?: string): Promise<IpcResult<Feed>>;
  removeFeed(url: string): Promise<IpcResult<boolean>>;
  pollFeeds(categories?: string[] | null): Promise<IpcResult<PollSummary>>;
  openExternal(url: string): Promise<IpcResult<void>>;
}

function bridge(): ReaderBridge | undefined {
  return (window as { geekspace?: { reader?: ReaderBridge } }).geekspace?.reader;
}

export const readerAvailable = (): boolean => Boolean(bridge());

async function call<T>(fn: (b: ReaderBridge) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const b = bridge();
  if (!b) return { ok: false, error: "The reader needs the desktop app window." };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

export const readerListFeeds = () => call((b) => b.listFeeds());
export const readerRecentItems = (limit = 200, since = "30d", category?: string) =>
  call((b) => b.recentItems(limit, since, category));
export const readerSearchItems = (query: string, limit = 200) =>
  call((b) => b.searchItems(query, limit));
export const readerMarkProcessed = (itemIds: string[], consumer = "geekspace-reader") =>
  call((b) => b.markProcessed(itemIds, consumer));
export const readerAddFeed = (url: string, category?: string) =>
  call((b) => b.addFeed(url, category));
export const readerRemoveFeed = (url: string) => call((b) => b.removeFeed(url));
export const readerPollFeeds = (categories?: string[] | null) =>
  call((b) => b.pollFeeds(categories));
export const readerOpenExternal = (url: string) => call((b) => b.openExternal(url));
