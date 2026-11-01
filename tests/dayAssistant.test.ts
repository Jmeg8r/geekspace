import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL, PRICES, costOf, createDayAssistant, type AssistantInput, type AssistantRequest } from "../electron/dayAssistant.mjs";
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
  parsed_output: { actions: object[] } | null;
  stop_reason: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

type ParseParams = AssistantRequest;
type UsageRow = { day: string; inputTokens: number; outputTokens: number; costUsd: number };

function harness(
  opts: {
    reply?: Reply;
    replyFn?: () => Promise<Reply>;
    key?: string | null;
    cap?: { capUsd: number | null; spentUsd: number; reached: boolean };
    input?: AssistantInput;
  } = {}
) {
  const requests: ParseParams[] = [];
  const applied: object[][] = [];
  const usage: UsageRow[] = [];
  const events: { kind: string; detail?: string }[] = [];
  const logs: string[] = [];
  let watermark = Date.now() - 900_000;
  const reply: Reply =
    opts.reply ?? {
          parsed_output: { actions: [{ type: "createTask", title: "Send the deck to Dana", estimateMin: 30, source: "t1" }] },
          stop_reason: "end_turn",
          model: MODEL,
          usage: { input_tokens: 2_000, output_tokens: 300 },
        };
  const client = {
    beta: {
      messages: {
        parse: vi.fn(async (params: ParseParams) => {
          requests.push(params);
          return opts.replyFn ? opts.replyFn() : reply;
        }),
      },
    },
  };
  const assistant = createDayAssistant({
    client: () => (opts.key === null ? null : client),
    convex: {
      input: async () => opts.input ?? INPUT,
      applyActions: async (actions: object[]) => void applied.push(actions),
      recordUsage: async (row: UsageRow) => void usage.push(row),
      capStatus: async () => opts.cap ?? { capUsd: 5, spentUsd: 0, reached: false },
      logEvent: async (e: { kind: string; detail?: string }) => void events.push(e),
      watermark: async () => watermark,
      setWatermark: async (t: number) => void (watermark = t),
    },
    log: (m: string) => void logs.push(m),
  });
  return { assistant, client, requests, applied, usage, events, logs, watermark: () => watermark };
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
  it("sends the new text, applies the allowed actions with their sources, and records the cost", async () => {
    const h = harness();
    await h.assistant.runBatch();
    expect(h.requests).toHaveLength(1);
    const body = JSON.stringify(h.requests[0]);
    expect(body).toContain("SYNTHETIC: send the deck to Dana by Friday");
    expect(h.applied).toEqual([[{ type: "createTask", title: "Send the deck to Dana", estimateMin: 30, sourceSegmentId: "seg1" }]]);
    expect(h.usage).toEqual([{ day: "2026-11-02", inputTokens: 2_000, outputTokens: 300, costUsd: costOf({ input_tokens: 2_000, output_tokens: 300 }, MODEL) }]);
    expect(h.watermark()).toBe(Date.now());
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

  it("rejects an action outside the allowed set, logs it, and applies the rest", async () => {
    const h = harness({
      reply: {
        parsed_output: {
          actions: [
            { type: "deleteEverything", target: "all" },
            { type: "createTask", title: "Book the retro", estimateMin: 15 },
          ],
        },
        stop_reason: "end_turn",
        model: MODEL,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    await h.assistant.runBatch();
    expect(h.applied).toEqual([[{ type: "createTask", title: "Book the retro", estimateMin: 15 }]]);
    expect(h.logs.some((l) => l.includes("rejected 1 action"))).toBe(true);
    expect(h.logs.join("\n")).not.toContain("deleteEverything");
  });

  it("drops a source the batch never had, keeping the action", async () => {
    const h = harness({
      reply: {
        parsed_output: { actions: [{ type: "createTask", title: "Ping Ravi", estimateMin: 10, source: "t99" }] },
        stop_reason: "end_turn",
        model: MODEL,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    await h.assistant.runBatch();
    expect(h.applied).toEqual([[{ type: "createTask", title: "Ping Ravi", estimateMin: 10 }]]);
  });

  it("maps a screenshot source to its screenshot id", async () => {
    const h = harness({
      reply: {
        parsed_output: { actions: [{ type: "draftLinear", issueRef: "GS-12", body: "SYNTHETIC update", source: "s1" }] },
        stop_reason: "end_turn",
        model: MODEL,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    await h.assistant.runBatch();
    expect(h.applied).toEqual([[{ type: "draftLinear", issueRef: "GS-12", body: "SYNTHETIC update", sourceScreenshotId: "shot1" }]]);
  });

  it("keeps the window for the next batch when the call fails, without recording any cost", async () => {
    const h = harness({
      replyFn: async () => {
        throw new Error("network down");
      },
    });
    const before = h.watermark();
    await h.assistant.runBatch();
    expect(h.watermark()).toBe(before);
    expect(h.usage).toEqual([]);
    expect(h.logs.join("\n")).not.toContain("SYNTHETIC");
  });

  it("moves past a refused or unparseable reply (it was paid for) and applies nothing", async () => {
    const h = harness({
      reply: { parsed_output: null, stop_reason: "refusal", model: MODEL, usage: { input_tokens: 100, output_tokens: 5 } },
    });
    await h.assistant.runBatch();
    expect(h.applied).toEqual([]);
    expect(h.usage).toHaveLength(1);
    expect(h.watermark()).toBe(Date.now());
  });

  it("moves past an empty window without a call", async () => {
    const h = harness({ input: { transcripts: [], screenshots: [] } });
    await h.assistant.runBatch();
    expect(h.requests).toEqual([]);
    expect(h.watermark()).toBe(Date.now());
  });

  it("never runs two batches at once", async () => {
    let finish: () => void = () => {};
    const h = harness({
      replyFn: () =>
        new Promise<Reply>((resolve) => {
          finish = () => resolve({ parsed_output: { actions: [] }, stop_reason: "end_turn", model: MODEL, usage: { input_tokens: 1, output_tokens: 1 } });
        }),
    });
    const first = h.assistant.runBatch();
    await vi.advanceTimersByTimeAsync(0);
    await h.assistant.runBatch();
    finish();
    await first;
    expect(h.requests).toHaveLength(1);
  });

  it("asks with structured output, a cap on output, and the refusal fallback", async () => {
    const h = harness();
    await h.assistant.runBatch();
    expect(h.requests[0]).toMatchObject({
      model: MODEL,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: expect.any(String), format: expect.anything() },
      max_tokens: expect.any(Number),
    });
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
