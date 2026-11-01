// WHAT: types for Linear drafts, so tests/ can import them.

export const LINEAR_API: string;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type LinearDrafts = { approve: (draftId: string) => Promise<void> };

export function createLinearDrafts(options: {
  keyStore: { get: () => string | null };
  fetch: FetchLike;
  convex: {
    draft: (draftId: string) => Promise<{ issueRef: string; body: string; status: string } | null>;
    setStatus: (draftId: string, status: "approved" | "pending" | "sent") => Promise<void>;
  };
  log: (message: string) => void;
}): LinearDrafts;

/** What the page may send: a key to save, or a draft id to approve (anything else is refused). */
export type LinearIpcArgs = { key?: string | number | null; draftId?: string | number | null };
export type LinearIpcReply = boolean | void | Promise<void>;

export function registerLinearIpc(options: {
  handle: (channel: string, fn: (args: LinearIpcArgs) => LinearIpcReply) => void;
  keyStore: { has: () => boolean; set: (key: string) => void; clear: () => void };
  drafts: () => LinearDrafts | null;
}): void;
