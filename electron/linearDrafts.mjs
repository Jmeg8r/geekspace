// WHAT: Linear drafts (plan PR 6b, spec R12). The assistant only drafts; a draft leaves
// Geekspace when James approves it, as a comment on its issue. Approval is the only code path
// here that calls Linear. The Linear key is kept like the assistant's (assistantKey.mjs).
// WHY claim first: the draft moves to "approved" before the request, so two clicks can't post
// twice; a send that fails moves it back to "pending", to be approved again.
// WHY no text in the log: a draft is made from captured content, and Linear's error messages
// can echo what was sent. A failure is logged with the draft id and an HTTP status or error
// code only, and never with the key.
// UNVERIFIED until James's key: that `issue(id:)` resolves an identifier like ENG-123 (Linear's
// GraphQL docs show it) and that a personal key goes in Authorization as is.

export const LINEAR_API = "https://api.linear.app/graphql";
const MAX_DRAFT_ID = 64;

const ISSUE = "query Issue($id: String!) { issue(id: $id) { id } }";
const COMMENT = "mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }";

/** A failure safe to log and to show: a status or a code, never text Linear echoed. */
class LinearError extends Error {}

export function createLinearDrafts({ keyStore, fetch, convex, log }) {
  async function graphql(key, query, variables) {
    let res;
    try {
      res = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new LinearError(`Linear couldn't be reached (${err?.code ?? err?.name ?? "network error"})`);
    }
    if (!res.ok) throw new LinearError(`Linear answered HTTP ${res.status}`);
    const reply = await res.json();
    if (Array.isArray(reply?.errors) && reply.errors.length > 0) {
      const code = reply.errors[0]?.extensions?.code;
      throw new LinearError(`Linear refused it (${typeof code === "string" ? code.slice(0, 40) : "error"})`);
    }
    return reply?.data ?? {};
  }

  return {
    /** James approved this draft: send it, or put it back in the queue and say why. */
    async approve(draftId) {
      const key = keyStore.get();
      if (!key) throw new Error("Add your Linear API key in Settings first");
      await convex.setStatus(draftId, "approved");
      try {
        const draft = await convex.draft(draftId);
        if (!draft) throw new LinearError("the draft is gone");
        const found = await graphql(key, ISSUE, { id: draft.issueRef });
        if (!found.issue?.id) throw new LinearError("Linear has no such issue");
        const sent = await graphql(key, COMMENT, { issueId: found.issue.id, body: draft.body });
        if (sent.commentCreate?.success !== true) throw new LinearError("Linear did not take the comment");
      } catch (err) {
        const why = err instanceof LinearError ? err.message : `Linear send failed (${err?.name ?? "Error"})`;
        log(`linear: draft ${draftId} not sent: ${why}; it is back in the queue`);
        try {
          await convex.setStatus(draftId, "pending");
        } catch (backErr) {
          log(`linear: draft ${draftId} could not go back in the queue (${backErr?.name ?? "Error"}); it stays approved`);
        }
        throw new Error(why);
      }
      await convex.setStatus(draftId, "sent");
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
