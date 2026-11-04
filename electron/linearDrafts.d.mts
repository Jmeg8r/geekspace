// WHAT: types for Linear drafts, so tests/ can import them.

export const LINEAR_API: string;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type LinearDrafts = { approve: (draftId: string) => Promise<void> };

export function createLinearDrafts(options: {
  keyStore: { get: () => string | null };
  fetch: FetchLike;
  convex: {
    /** pending → approved under `claimId`; the comment id is the draft's own once it has one. */
    claim: (draftId: string, commentId: string, claimId: string) => Promise<{ issueRef: string; body: string; commentId: string; deliveryUnknown: boolean }>;
    /** approved → pending; false when the claim no longer holds the draft. `deliveryUnknown` sticks. */
    release: (draftId: string, claimId: string, deliveryUnknown: boolean) => Promise<boolean>;
    /** approved → sent; false when the claim no longer holds the draft. */
    markSent: (draftId: string, claimId: string) => Promise<boolean>;
  };
  log: (message: string) => void;
  /** A UUID v4, for a comment id and for each claim. */
  newId?: () => string;
}): LinearDrafts;

/** What the page may send: a key to save, or a draft id to approve (anything else is refused). */
export type LinearIpcArgs = { key?: string | number | null; draftId?: string | number | null };
export type LinearIpcReply = boolean | void | Promise<void>;

export function registerLinearIpc(options: {
  handle: (channel: string, fn: (args: LinearIpcArgs) => LinearIpcReply) => void;
  keyStore: { has: () => boolean; set: (key: string) => void; clear: () => void };
  drafts: () => LinearDrafts | null;
}): void;
