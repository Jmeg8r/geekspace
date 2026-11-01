import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL,
  PRICES,
  STOP_GRACE_MS,
  assistantClient,
  costOf,
  createDayAssistant,
  type AssistantInput,
  type AssistantRequest,
} from "../electron/dayAssistant.mjs";
import { createKeyStore, registerAssistantIpc } from "../electron/assistantKey.mjs";

// WHAT: the Day Recorder's assistant (plan PR 6a, spec R8, R10, F4). WHY tested: it is the only
// code that sends captured text to a cloud model and turns the reply into tasks and blocks, so
// it must stay under the daily cap, account every call, accept only the allowed actions, and
// never run without a key. The client is a stub: no request leaves the test.
// SYNTHETIC: every id, text and key below is invented.

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const INPUT: AssistantInput = {
  transcripts: [{ _id: "tr1", segmentId: "seg1", start: Date.now() - 600_000, end: Date.now() - 300_000, text: "SYNTHETIC: send the deck to Dana by Friday" }],
  screenshots: [{ _id: "shot1", takenAt: Date.now() - 400_000, appBundleId: "com.example.editor", ocrText: "SYNTHETIC: Q4 plan draft" }],
};

type Reply = {
  content: { type: "text"; text: string }[];
  stop_reason: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

const reply = (actions: object[], usage = { input_tokens: 2_000, output_tokens: 300 }): Reply => ({
  content: [{ type: "text", text: JSON.stringify({ actions }) }],
  stop_reason: "end_turn",
  model: MODEL,
  usage,
});

type Open = { _id: string; status: "inFlight" | "settled"; proposals: { proposal: object; state: string }[] };

function harness(
  opts: {
    reply?: Reply;
    replyFn?: () => Promise<Reply>;
    key?: string | null;
    cap?: { capUsd: number | null; spentUsd: number; reached: boolean };
    input?: AssistantInput;
    begin?: () => string | null;
    settleFails?: number;
    applyFails?: boolean;
    open?: Open[];
  } = {}
) {
  const requests: AssistantRequest[] = [];
  const calls: string[] = [];
  const begun: { reservedUsd: number; transcriptIds: string[]; screenshotIds: string[] }[] = [];
  const settled: { requestId: string; costUsd: number; proposals: object[] }[] = [];
  const events: { kind: string; detail?: string }[] = [];
  const logs: string[] = [];
  let settleFails = opts.settleFails ?? 0;
  let open = opts.open ?? [];
  const client = {
    messages: {
      create: vi.fn(async (params: AssistantRequest) => {
        requests.push(params);
        return opts.replyFn ? opts.replyFn() : (opts.reply ?? reply([{ type: "createTask", title: "Send the deck to Dana", estimateMin: 30, source: "t1" }]));
      }),
    },
  };
  const assistant = createDayAssistant({
    client: () => (opts.key === null ? null : client),
    convex: {
      ensureStart: async ({ at }: { at: number }) => {
        calls.push(`start ${at}`);
        return at;
      },
      unread: async () => opts.input ?? INPUT,
      capStatus: async () => opts.cap ?? { capUsd: 5, spentUsd: 0, reached: false },
      beginRequest: async (args: { reservedUsd: number; transcriptIds: string[]; screenshotIds: string[] }) => {
        begun.push(args);
        return opts.begin ? opts.begin() : "req1";
      },
      settleRequest: async (args: { requestId: string; costUsd: number; proposals: object[] }) => {
        if (settleFails > 0) {
          settleFails -= 1;
          throw new Error("backend down");
        }
        settled.push(args);
        open = [{ _id: args.requestId, status: "settled", proposals: args.proposals.map((proposal) => ({ proposal, state: "pending" })) }];
      },
      failRequest: async ({ requestId }: { requestId: string }) => void calls.push(`fail ${requestId}`),
      openRequests: async () => open,
      applyProposal: async ({ requestId, index }: { requestId: string; index: number }) => {
        if (opts.applyFails) throw new Error("refused");
        calls.push(`apply ${requestId}#${index}`);
        open = open.map((r) => (r._id === requestId ? { ...r, proposals: r.proposals.map((p, i) => (i === index ? { ...p, state: "applied" } : p)) } : r));
      },
      refuseProposal: async ({ requestId, index }: { requestId: string; index: number }) => {
        calls.push(`refuse ${requestId}#${index}`);
        open = open.map((r) => (r._id === requestId ? { ...r, proposals: r.proposals.map((p, i) => (i === index ? { ...p, state: "refused" } : p)) } : r));
      },
      logEvent: async (e: { kind: string; detail?: string }) => void events.push(e),
    },
    log: (m: string) => void logs.push(m),
  });
  return { assistant, client, requests, calls, begun, settled, events, logs };
}

describe("costOf", () => {
  it("prices input, output and cache tokens by the model that answered", () => {
    expect(PRICES[MODEL]).toBeDefined();
    const cost = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }, MODEL);
    const p = PRICES[MODEL];
    expect(cost).toBeCloseTo(p.input + p.output + p.cacheRead + p.input * 1.25, 6);
  });

  it("prices an unknown model at the dearest known rate, so the cap is never under-counted", () => {
    const dearest = Math.max(...Object.values(PRICES).map((p) => p.output));
    expect(costOf({ input_tokens: 0, output_tokens: 1_000_000 }, "claude-unknown")).toBe(dearest);
  });
});

describe("createDayAssistant.runBatch", () => {
  it("sends the unread text, settles its cost with the proposals, then applies them", async () => {
    const h = harness();
    await h.assistant.runBatch();
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.requests[0])).toContain("SYNTHETIC: send the deck to Dana by Friday");
    expect(h.begun[0]).toMatchObject({ transcriptIds: ["tr1"], screenshotIds: ["shot1"] });
    expect(h.settled).toEqual([
      {
        requestId: "req1",
        inputTokens: 2_000,
        outputTokens: 300,
        costUsd: costOf({ input_tokens: 2_000, output_tokens: 300 }, MODEL),
        proposals: [{ type: "createTask", title: "Send the deck to Dana", estimateMin: 30, sourceSegmentId: "seg1" }],
      },
    ]);
    expect(h.calls).toContain("apply req1#0");
  });

  it("[P1] starts from the beginning of the local day, not a rolling 15 minutes", async () => {
    const h = harness();
    await h.assistant.runBatch();
    const midnight = new Date(Date.now());
    midnight.setHours(0, 0, 0, 0);
    expect(h.calls[0]).toBe(`start ${midnight.getTime()}`);
  });

  it("does nothing without an API key", async () => {
    const h = harness({ key: null });
    await h.assistant.runBatch();
    expect(h.requests).toEqual([]);
    expect(h.logs.some((l) => l.includes("no API key"))).toBe(true);
  });

  it("skips a batch when the day's cap is reached, and says so once a day", async () => {
    const h = harness({ cap: { capUsd: 2, spentUsd: 2.01, reached: true } });
    await h.assistant.runBatch();
    await h.assistant.runBatch();
    expect(h.requests).toEqual([]);
    expect(h.events.filter((e) => e.kind === "capPaused")).toHaveLength(1);
  });

  it("does not run with no cap set", async () => {
    const h = harness({ cap: { capUsd: null, spentUsd: 0, reached: true } });
    await h.assistant.runBatch();
    expect(h.requests).toEqual([]);
  });

  it("[P1] reserves the call's worst case inside what is left, and sizes max_tokens to fit", async () => {
    const h = harness({ cap: { capUsd: 1, spentUsd: 0.7, reached: false } });
    await h.assistant.runBatch();
    expect(h.begun).toHaveLength(1);
    expect(h.begun[0].reservedUsd).toBeLessThanOrEqual(0.3 + 1e-9);
    const dearestOut = Math.max(...Object.values(PRICES).map((p) => p.output)) / 1_000_000;
    expect(h.requests[0].max_tokens * dearestOut).toBeLessThan(h.begun[0].reservedUsd + 1e-9);
  });

  it("[P1] makes no call when what is left can't cover one, and says so", async () => {
    const h = harness({ cap: { capUsd: 0.05, spentUsd: 0.0499, reached: false } });
    await h.assistant.runBatch();
    expect(h.requests).toEqual([]);
    expect(h.events.some((e) => e.kind === "capPaused")).toBe(true);
  });

  it("[P1] makes no call when the backend refuses the reservation", async () => {
    const h = harness({ begin: () => null });
    await h.assistant.runBatch();
    expect(h.requests).toEqual([]);
  });

  it("rejects an action outside the allowed set, logs it without its content, and keeps the rest", async () => {
    const h = harness({ reply: reply([{ type: "deleteEverything", target: "all" }, { type: "createTask", title: "Book the retro", estimateMin: 15 }]) });
    await h.assistant.runBatch();
    expect(h.settled[0].proposals).toEqual([{ type: "createTask", title: "Book the retro", estimateMin: 15 }]);
    expect(h.logs.some((l) => l.includes("rejected 1 action"))).toBe(true);
    expect(h.logs.join("\n")).not.toContain("deleteEverything");
  });

  it("drops a source the batch never had, and maps a screenshot source to its id", async () => {
    const h = harness({
      reply: reply([
        { type: "createTask", title: "Ping Ravi", estimateMin: 10, source: "t99" },
        { type: "draftLinear", issueRef: "GS-12", body: "SYNTHETIC update", source: "s1" },
      ]),
    });
    await h.assistant.runBatch();
    expect(h.settled[0].proposals).toEqual([
      { type: "createTask", title: "Ping Ravi", estimateMin: 10 },
      { type: "draftLinear", issueRef: "GS-12", body: "SYNTHETIC update", sourceScreenshotId: "shot1" },
    ]);
  });

  it("[P1] a reply that isn't valid structured output is still paid for and settled, with no proposals", async () => {
    const h = harness({ reply: { content: [{ type: "text", text: "not json" }], stop_reason: "end_turn", model: MODEL, usage: { input_tokens: 100, output_tokens: 5 } } });
    await h.assistant.runBatch();
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0].costUsd).toBeGreaterThan(0);
    expect(h.settled[0].proposals).toEqual([]);
  });

  it("a refusal is settled too, with nothing applied", async () => {
    const h = harness({ reply: { content: [], stop_reason: "refusal", model: MODEL, usage: { input_tokens: 100, output_tokens: 5 } } });
    await h.assistant.runBatch();
    expect(h.settled[0].proposals).toEqual([]);
  });

  it("a call that fails frees its reservation, with nothing settled and nothing logged of the text", async () => {
    const h = harness({
      replyFn: async () => {
        throw new Error("network down");
      },
    });
    await h.assistant.runBatch();
    expect(h.calls).toContain("fail req1");
    expect(h.settled).toEqual([]);
    expect(h.logs.join("\n")).not.toContain("SYNTHETIC");
  });

  it("[P1] a settle that fails is written first next time, before any new call", async () => {
    const h = harness({ settleFails: 1 });
    await h.assistant.runBatch();
    expect(h.settled).toEqual([]);
    await h.assistant.runBatch();
    expect(h.requests).toHaveLength(1);
    expect(h.settled).toHaveLength(1);
  });

  it("[P1] applies an earlier call's kept proposals before making a new one", async () => {
    const h = harness({
      open: [{ _id: "req0", status: "settled", proposals: [{ proposal: { type: "createTask", title: "Old", estimateMin: 5 }, state: "pending" }] }],
    });
    await h.assistant.runBatch();
    expect(h.calls.indexOf("apply req0#0")).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("apply req0#0")).toBeLessThan(h.calls.indexOf("apply req1#0"));
  });

  it("refuses a proposal Geekspace won't take, so it isn't tried forever", async () => {
    const h = harness({ applyFails: true });
    await h.assistant.runBatch();
    expect(h.calls).toContain("refuse req1#0");
  });

  it("makes no call when nothing is unread", async () => {
    const h = harness({ input: { transcripts: [], screenshots: [] } });
    await h.assistant.runBatch();
    expect(h.requests).toEqual([]);
    expect(h.begun).toEqual([]);
  });

  it("never runs two batches at once, and stop waits for the one running", async () => {
    let finish: () => void = () => {};
    const h = harness({
      replyFn: () =>
        new Promise<Reply>((resolve) => {
          finish = () => resolve(reply([]));
        }),
    });
    const first = h.assistant.runBatch();
    await vi.advanceTimersByTimeAsync(0);
    await h.assistant.runBatch();
    let stopped = false;
    const stopping = h.assistant.stop().then(() => void (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await first;
    await stopping;
    expect(h.requests).toHaveLength(1);
    expect(h.settled).toHaveLength(1);
  });

  it("stop gives up on a call that never answers after its grace, and says so", async () => {
    const h = harness({ replyFn: () => new Promise<Reply>(() => {}) });
    void h.assistant.runBatch();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    void h.assistant.stop().then(() => void (stopped = true));
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    expect(stopped).toBe(true);
    expect(h.logs.some((l) => l.includes("reservation"))).toBe(true);
  });

  it("asks with structured output and an output cap, on the model it names, without the fallback beta", async () => {
    const h = harness();
    await h.assistant.runBatch();
    expect(h.requests[0]).toMatchObject({
      model: MODEL,
      output_config: { effort: expect.any(String), format: { type: "json_schema", schema: expect.anything() } },
      max_tokens: expect.any(Number),
    });
    expect(h.requests[0]).not.toHaveProperty("betas");
    expect(h.requests[0]).not.toHaveProperty("fallbacks");
  });
});

// Codex 6a r1 P1: the SDK took ANTHROPIC_LOG from the environment, and at debug it logs the
// request: the whole batch of captured text.
describe("assistantClient", () => {
  it("[P1] never logs, whatever ANTHROPIC_LOG says", () => {
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const client = assistantClient("sk-ant-SYNTHETIC");
    expect(client.logLevel).toBe("off");
    vi.unstubAllEnvs();
  });
});

describe("createKeyStore", () => {
  function fakes() {
    const files = new Map<string, { data: Buffer; mode: number }>();
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`enc:${s}`),
      decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ""),
    };
    const fsImpl = {
      writeFileSync: (p: string, data: Buffer, o: { mode: number }) => void files.set(p, { data, mode: o.mode }),
      readFileSync: (p: string) => {
        const f = files.get(p);
        if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return f.data;
      },
      rmSync: (p: string) => void files.delete(p),
      existsSync: (p: string) => files.has(p),
    };
    return { files, safeStorage, fsImpl };
  }

  it("keeps the key only encrypted, readable by the owner alone", () => {
    const f = fakes();
    const store = createKeyStore({ file: "/x/key.bin", safeStorage: f.safeStorage, fs: f.fsImpl });
    store.set("sk-ant-SYNTHETIC-key");
    const saved = f.files.get("/x/key.bin")!;
    expect(saved.data.toString()).not.toBe("sk-ant-SYNTHETIC-key");
    expect(saved.mode).toBe(0o600);
    expect(store.has()).toBe(true);
    expect(store.get()).toBe("sk-ant-SYNTHETIC-key");
    store.clear();
    expect(store.has()).toBe(false);
    expect(store.get()).toBeNull();
  });

  it("refuses an empty or malformed key, and refuses to store one unencrypted", () => {
    const f = fakes();
    const store = createKeyStore({ file: "/x/key.bin", safeStorage: f.safeStorage, fs: f.fsImpl });
    expect(() => store.set("")).toThrow(/key/);
    expect(() => store.set("has spaces in it")).toThrow(/key/);
    const plain = createKeyStore({ file: "/x/key.bin", safeStorage: { ...f.safeStorage, isEncryptionAvailable: () => false }, fs: f.fsImpl });
    expect(() => plain.set("sk-ant-SYNTHETIC")).toThrow(/Keychain/);
  });
});

// Plan PR 6a, spec F4: the key goes in from Settings and never comes back out.
describe("registerAssistantIpc", () => {
  it("registers only the write-only key channels, through the guarded handle()", async () => {
    const handlers = new Map<string, (args: { key?: string | number | null }) => boolean | void>();
    const store = { set: vi.fn(), has: vi.fn(() => true), clear: vi.fn(), get: vi.fn(() => "sk-ant-SYNTHETIC") };
    registerAssistantIpc({ handle: (ch, fn) => void handlers.set(ch, fn), keyStore: store });
    expect([...handlers.keys()].sort()).toEqual(["gs:assistant:clearApiKey", "gs:assistant:hasApiKey", "gs:assistant:setApiKey"]);
    expect(handlers.get("gs:assistant:hasApiKey")!({})).toBe(true);
    expect(handlers.get("gs:assistant:setApiKey")!({ key: "sk-ant-SYNTHETIC" })).toBeUndefined();
    expect(store.set).toHaveBeenCalledWith("sk-ant-SYNTHETIC");
    expect(() => handlers.get("gs:assistant:setApiKey")!({ key: 42 })).toThrow(/key/);
    handlers.get("gs:assistant:clearApiKey")!({});
    expect(store.clear).toHaveBeenCalledOnce();
    expect(store.get).not.toHaveBeenCalled();
  });
});
