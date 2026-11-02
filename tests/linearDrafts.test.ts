import { describe, expect, it, vi } from "vitest";
import { LINEAR_API, createLinearDrafts, registerLinearIpc, type LinearIpcArgs, type LinearIpcReply } from "../electron/linearDrafts.mjs";

// WHAT: Linear drafts leave Geekspace only when James approves one (plan PR 6b, spec R12).
// WHY tested: approval is the only code path that calls Linear; the key and the draft's text
// never reach a log; a send that fails puts the draft back in the queue.
// SYNTHETIC: the key, issue and text are invented.

const KEY = "lin_api_SYNTHETIC0000000000";
const BODY = "SYNTHETIC: the deck went out on Thursday";

type Reply = { status?: number; json?: unknown; network?: boolean; unreadable?: boolean };
type Draft = { status: string; commentId?: string; deliveryUnknown?: boolean };

const ISSUE_OK: Reply = { json: { data: { issue: { id: "uuid-1" } } } };
const COMMENT_OK: Reply = { json: { data: { commentCreate: { success: true } } } };
const IDS = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];

function harness(opts: { key?: string | null; replies?: Reply[]; status?: string; draft?: Draft } = {}) {
  const requests: { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, string> } }[] = [];
  const replies = [...(opts.replies ?? [ISSUE_OK, COMMENT_OK])];
  // Linear as the test sees it: the comments it holds, by the id the client gave them.
  const posted: { id: string; body: string }[] = [];
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    const r = replies.shift() ?? { status: 500 };
    // A comment that reached Linear is kept, whatever happens to the answer after.
    if (body.query.includes("commentCreate") && (r.network || r.unreadable || (r.status ?? 200) >= 500 || r === COMMENT_OK)) {
      if (!posted.some((c) => c.id === body.variables.id)) posted.push({ id: body.variables.id, body: body.variables.body });
    }
    if (r.network) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    return {
      ok: (r.status ?? 200) < 300,
      status: r.status ?? 200,
      json: async () => {
        if (r.unreadable) throw new SyntaxError("Unexpected end of JSON input");
        return r.json ?? {};
      },
    };
  });
  const draft: Draft = { ...(opts.draft ?? { status: opts.status ?? "pending" }) };
  const statuses: string[] = [];
  const logs: string[] = [];
  const ids = [...IDS];
  const drafts = createLinearDrafts({
    keyStore: { get: () => (opts.key === undefined ? KEY : opts.key) },
    fetch,
    newId: () => ids.shift()!,
    convex: {
      claim: async (_id: string, commentId: string) => {
        if (draft.status !== "pending") throw new Error(`Cannot move a draft from ${draft.status} to approved`);
        draft.status = "approved";
        draft.commentId ??= commentId;
        statuses.push("approved");
        return { issueRef: "ENG-42", body: BODY, commentId: draft.commentId, deliveryUnknown: draft.deliveryUnknown === true };
      },
      release: async (_id: string, deliveryUnknown: boolean) => {
        draft.status = "pending";
        draft.deliveryUnknown = draft.deliveryUnknown === true || deliveryUnknown;
        statuses.push("pending");
      },
      markSent: async () => {
        draft.status = "sent";
        statuses.push("sent");
      },
    },
    log: (m: string) => void logs.push(m),
  });
  return { drafts, fetch, requests, statuses, logs, posted, draft, replies, status: () => draft.status };
}

describe("createLinearDrafts", () => {
  it("makes no request to Linear before an approval", () => {
    const h = harness();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("an approval claims the draft, comments on the issue with the key, and marks it sent", async () => {
    const h = harness();
    await h.drafts.approve("draft-1");
    expect(h.requests.map((r) => r.url)).toEqual([LINEAR_API, LINEAR_API]);
    expect(h.requests[0].headers.Authorization).toBe(KEY);
    expect(h.requests[0].body.variables).toEqual({ id: "ENG-42" });
    expect(h.requests[1].body.variables).toEqual({ id: IDS[0], issueId: "uuid-1", body: BODY });
    expect(h.statuses).toEqual(["approved", "sent"]);
  });

  it("with no key, says so and touches neither the draft nor Linear", async () => {
    const h = harness({ key: null });
    await expect(h.drafts.approve("draft-1")).rejects.toThrow(/Linear API key/);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.statuses).toEqual([]);
  });

  it("a draft that is not waiting is not sent", async () => {
    const h = harness({ status: "sent" });
    await expect(h.drafts.approve("draft-1")).rejects.toThrow(/sent/);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTTP error", [{ status: 500 }]],
    ["a GraphQL error", [{ json: { errors: [{ message: `bad ${BODY}`, extensions: { code: "INPUT_ERROR" } }] } }]],
    ["an issue that does not exist", [{ json: { data: { issue: null } } }]],
    ["a comment Linear did not take", [{ json: { data: { issue: { id: "uuid-1" } } } }, { json: { data: { commentCreate: { success: false } } } }]],
  ])("%s puts the draft back in the queue, loudly, with no key or text in the log", async (_name, replies) => {
    const h = harness({ replies });
    await expect(h.drafts.approve("draft-1")).rejects.toThrow(/Linear/);
    expect(h.status()).toBe("pending");
    // Linear refused it or never got it, so it is not in doubt.
    expect(h.draft.deliveryUnknown).toBe(false);
    expect(h.logs.length).toBeGreaterThan(0);
    const logged = h.logs.join("\n");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("SYNTHETIC: the deck");
  });
});

// Codex 6b r1 P1: a comment Linear took whose answer was lost must not be posted twice.
describe("a send whose answer was lost", () => {
  it.each([
    ["the connection dropped", { network: true }],
    ["Linear answered 502", { status: 502 }],
    ["the answer could not be read", { unreadable: true }],
  ] as [string, Reply][])("%s: the draft goes back marked unknown, and the next approval finds the comment instead of posting again", async (_name, lost) => {
    const h = harness({ replies: [ISSUE_OK, lost] });
    await expect(h.drafts.approve("draft-1")).rejects.toThrow(/Linear/);
    expect(h.posted).toHaveLength(1);
    expect(h.draft).toMatchObject({ status: "pending", commentId: IDS[0], deliveryUnknown: true });

    h.replies.push({ json: { data: { comment: { id: IDS[0] } } } });
    await h.drafts.approve("draft-1");
    expect(h.posted).toHaveLength(1);
    expect(h.status()).toBe("sent");
    expect(h.requests.at(-1)!.body.variables).toEqual({ id: IDS[0] });
    expect(h.requests.filter((r) => r.body.query.includes("commentCreate"))).toHaveLength(1);
  });

  it("when Linear has no such comment, the next approval posts it again under the same id", async () => {
    const h = harness({ replies: [ISSUE_OK, { network: true }] });
    await expect(h.drafts.approve("draft-1")).rejects.toThrow(/Linear/);
    expect(h.posted).toHaveLength(1);
    h.posted.length = 0;
    h.replies.push({ json: { errors: [{ message: "Entity not found", extensions: { code: "INVALID_INPUT" } }] } }, ISSUE_OK, COMMENT_OK);
    await h.drafts.approve("draft-1");
    const creates = h.requests.filter((r) => r.body.query.includes("commentCreate"));
    expect(creates.map((r) => r.body.variables.id)).toEqual([IDS[0], IDS[0]]);
    expect(h.status()).toBe("sent");
  });

  it("a check that can't reach Linear keeps the draft unknown and posts nothing", async () => {
    const h = harness({ draft: { status: "pending", commentId: IDS[0], deliveryUnknown: true }, replies: [{ network: true }] });
    await expect(h.drafts.approve("draft-1")).rejects.toThrow(/Linear/);
    expect(h.requests.filter((r) => r.body.query.includes("commentCreate"))).toHaveLength(0);
    expect(h.draft).toMatchObject({ status: "pending", commentId: IDS[0], deliveryUnknown: true });
  });
});

describe("registerLinearIpc", () => {
  function channels(drafts = { approve: vi.fn(async () => {}) }) {
    const handlers = new Map<string, (args: LinearIpcArgs) => LinearIpcReply>();
    const store = { has: vi.fn(() => true), set: vi.fn(), clear: vi.fn() };
    registerLinearIpc({ handle: (name, fn) => void handlers.set(name, fn), keyStore: store, drafts: () => drafts });
    return { handlers, store, drafts };
  }

  it("is write-only for the key, and approves by draft id", async () => {
    const c = channels();
    expect([...c.handlers.keys()].sort()).toEqual(["gs:linear:approve", "gs:linear:clearApiKey", "gs:linear:hasApiKey", "gs:linear:setApiKey"]);
    expect(c.handlers.get("gs:linear:hasApiKey")?.({})).toBe(true);
    await c.handlers.get("gs:linear:approve")?.({ draftId: "draft-1" });
    expect(c.drafts.approve).toHaveBeenCalledWith("draft-1");
  });

  it("refuses a draft id that is not a short string", () => {
    const c = channels();
    expect(() => c.handlers.get("gs:linear:approve")?.({ draftId: 7 })).toThrow(/draft/);
    expect(() => c.handlers.get("gs:linear:approve")?.({ draftId: "x".repeat(65) })).toThrow(/draft/);
  });

  it("says so when the recorder has not started", () => {
    const handlers = new Map<string, (args: LinearIpcArgs) => LinearIpcReply>();
    registerLinearIpc({ handle: (name, fn) => void handlers.set(name, fn), keyStore: { has: () => false, set: () => {}, clear: () => {} }, drafts: () => null });
    expect(() => handlers.get("gs:linear:approve")?.({ draftId: "draft-1" })).toThrow(/not running/);
  });
});
