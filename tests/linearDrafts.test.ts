import { describe, expect, it, vi } from "vitest";
import { LINEAR_API, createLinearDrafts, registerLinearIpc } from "../electron/linearDrafts.mjs";

// WHAT: Linear drafts leave Geekspace only when James approves one (plan PR 6b, spec R12).
// WHY tested: approval is the only code path that calls Linear; the key and the draft's text
// never reach a log; a send that fails puts the draft back in the queue.
// SYNTHETIC: the key, issue and text are invented.

const KEY = "lin_api_SYNTHETIC0000000000";
const BODY = "SYNTHETIC: the deck went out on Thursday";

type Reply = { status?: number; json?: unknown };

function harness(opts: { key?: string | null; replies?: Reply[]; status?: string } = {}) {
  const requests: { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, string> } }[] = [];
  const replies = [...(opts.replies ?? [{ json: { data: { issue: { id: "uuid-1" } } } }, { json: { data: { commentCreate: { success: true } } } }])];
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 500 };
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.json ?? {} };
  });
  let status = opts.status ?? "pending";
  const statuses: string[] = [];
  const logs: string[] = [];
  const drafts = createLinearDrafts({
    keyStore: { get: () => (opts.key === undefined ? KEY : opts.key) },
    fetch,
    convex: {
      draft: async () => ({ issueRef: "ENG-42", body: BODY, status }),
      setStatus: async (_id: string, next: string) => {
        if (next === "approved" && status !== "pending") throw new Error(`Cannot move a draft from ${status} to approved`);
        status = next;
        statuses.push(next);
      },
    },
    log: (m: string) => void logs.push(m),
  });
  return { drafts, fetch, requests, statuses, logs, status: () => status };
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
    expect(h.requests[1].body.variables).toEqual({ issueId: "uuid-1", body: BODY });
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
    expect(h.logs.length).toBeGreaterThan(0);
    const logged = h.logs.join("\n");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("SYNTHETIC: the deck");
  });
});

describe("registerLinearIpc", () => {
  function channels(drafts = { approve: vi.fn(async () => {}) }) {
    const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
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
    const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
    registerLinearIpc({ handle: (name, fn) => void handlers.set(name, fn), keyStore: { has: () => false, set: () => {}, clear: () => {} }, drafts: () => null });
    expect(() => handlers.get("gs:linear:approve")?.({ draftId: "draft-1" })).toThrow(/not running/);
  });
});
