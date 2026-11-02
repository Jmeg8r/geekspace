// WHAT: Linear drafts (plan PR 6b, spec R12). The assistant only drafts; a draft leaves
// Geekspace when James approves it, as a comment on its issue. Approval is the only code path
// here that calls Linear. The Linear key is kept like the assistant's (assistantKey.mjs).
// WHY claim first: the draft moves to "approved" before the request, so two clicks can't post
// twice; a send that fails moves it back to "pending", to be approved again.
// WHY a comment id of our own (Codex review of PR 6b, round 1): a send can fail after Linear
// took the comment (the connection drops, the answer is unreadable). Each draft keeps one id,
// given at its first claim, and the comment is created under it. A failure after the request
// left marks the draft in doubt, and the next approval asks Linear for that comment before it
// posts: there, it is marked sent; not there, it is posted again under the same id, which
// Linear will not take twice. Only a failure that proves nothing arrived leaves no doubt.
// WHY no text in the log: a draft is made from captured content, and Linear's error messages
// can echo what was sent. A failure is logged with the draft id and an HTTP status or error
// code only, and never with the key.
// UNVERIFIED until James's key: that `issue(id:)` resolves an identifier like ENG-123 (Linear's
// GraphQL docs show it), that a personal key goes in Authorization as is, and that
// commentCreate keeps a client-given id and refuses it a second time.

export const LINEAR_API = "https://api.linear.app/graphql";
const MAX_DRAFT_ID = 64;

const ISSUE = "query Issue($id: String!) { issue(id: $id) { id } }";
const FIND = "query Comment($id: String!) { comment(id: $id) { id } }";
const COMMENT =
  "mutation Comment($id: String!, $issueId: String!, $body: String!) { commentCreate(input: { id: $id, issueId: $issueId, body: $body }) { success } }";
// 4xx is Linear refusing the request, so nothing was done; a request timeout is not that.
const REQUEST_TIMEOUT = 408;
// Each request's deadline; three of them end well inside a claim's lease (convex/assistant.ts
// CLAIM_LEASE_MS), so a claim still held past it was abandoned.
const LINEAR_TIMEOUT_MS = 30_000;
// How Linear says it has no entity by that id. Matched, never logged: messages can echo input.
const NOT_FOUND_RE = /not found/i;

/**
 * A failure safe to log and to show: a status or a code, never text Linear echoed.
 * `answered` is true when Linear's answer proves it did not act on the request.
 */
class LinearError extends Error {
  constructor(message, { answered = false, notFound = false } = {}) {
    super(message);
    this.answered = answered;
    this.notFound = notFound;
  }
}

export function createLinearDrafts({ keyStore, fetch, convex, log, newId = () => crypto.randomUUID() }) {
  async function graphql(key, query, variables) {
    let res;
    try {
      res = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS),
      });
    } catch (err) {
      throw new LinearError(`Linear couldn't be reached (${err?.code ?? err?.name ?? "network error"})`);
    }
    if (!res.ok) {
      const answered = res.status >= 400 && res.status < 500 && res.status !== REQUEST_TIMEOUT;
      throw new LinearError(`Linear answered HTTP ${res.status}`, { answered });
    }
    let reply;
    try {
      reply = await res.json();
    } catch (err) {
      throw new LinearError(`Linear's answer could not be read (${err?.name ?? "Error"})`);
    }
    if (Array.isArray(reply?.errors) && reply.errors.length > 0) {
      const code = reply.errors[0]?.extensions?.code;
      const notFound = reply.errors.every((e) => typeof e?.message === "string" && NOT_FOUND_RE.test(e.message));
      // A refusal of a create may be Linear refusing an id it already has: not proof either way.
      throw new LinearError(`Linear refused it (${typeof code === "string" ? code.slice(0, 40) : "error"})`, { notFound });
    }
    return reply?.data ?? {};
  }

  /** Whether Linear has the comment of an earlier send in doubt. Unknown throws. */
  async function delivered(key, commentId) {
    try {
      return (await graphql(key, FIND, { id: commentId })).comment?.id === commentId;
    } catch (err) {
      // Only Linear saying it has no such comment proves it is not there (Codex 6b r2).
      if (err instanceof LinearError && err.notFound) return false;
      throw err;
    }
  }

  return {
    /** James approved this draft: send it, or put it back in the queue and say why. */
    async approve(draftId) {
      const key = keyStore.get();
      if (!key) throw new Error("Add your Linear API key in Settings first");
      const draft = await convex.claim(draftId, newId());
      let requested = false;
      try {
        if (draft.deliveryUnknown && (await delivered(key, draft.commentId))) {
          await convex.markSent(draftId);
          log(`linear: draft ${draftId} was already on its issue; marked sent`);
          return;
        }
        const found = await graphql(key, ISSUE, { id: draft.issueRef });
        if (!found.issue?.id) throw new LinearError("Linear has no such issue", { answered: true });
        requested = true;
        const sent = await graphql(key, COMMENT, { id: draft.commentId, issueId: found.issue.id, body: draft.body });
        if (sent.commentCreate?.success !== true) throw new LinearError("Linear did not take the comment", { answered: true });
      } catch (err) {
        const why = err instanceof LinearError ? err.message : `Linear send failed (${err?.name ?? "Error"})`;
        const inDoubt = requested && !(err instanceof LinearError && err.answered);
        log(`linear: draft ${draftId} not sent: ${why}; it is back in the queue${inDoubt ? ", and checked with Linear before it is sent again" : ""}`);
        try {
          await convex.release(draftId, inDoubt);
        } catch (backErr) {
          log(`linear: draft ${draftId} could not go back in the queue (${backErr?.name ?? "Error"}); it stays approved`);
        }
        throw new Error(why);
      }
      await convex.markSent(draftId);
      log(`linear: draft ${draftId} sent`);
    },
  };
}

/**
 * The page's Linear channels, through main.mjs's guarded handle(). The key is write-only, as
 * the assistant's is; approving takes a draft id and nothing else.
 */
export function registerLinearIpc({ handle, keyStore, drafts }) {
  handle("gs:linear:hasApiKey", () => keyStore.has());
  handle("gs:linear:setApiKey", ({ key }) => {
    if (typeof key !== "string") throw new Error("An API key is text");
    keyStore.set(key);
  });
  handle("gs:linear:clearApiKey", () => {
    keyStore.clear();
  });
  handle("gs:linear:approve", ({ draftId }) => {
    if (typeof draftId !== "string" || draftId.length === 0 || draftId.length > MAX_DRAFT_ID) {
      throw new Error("That is not a draft id");
    }
    const live = drafts();
    if (!live) throw new Error("The Day Recorder is not running, so nothing can be sent");
    return live.approve(draftId);
  });
}
