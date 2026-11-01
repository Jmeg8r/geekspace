import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTEND_MS, NOTICE_TIMEOUT_MS, createCallNotice, statusWithCall, type CallPrompt } from "../electron/callNotice.mjs";

// WHAT: the call notice (plan PR 4b, spec R5 / F3). WHY tested: this is where "no call audio
// is written without a notice" is decided. Without a notice the helper is only ever told to
// discard, the mic stays off, and nothing is released; with one, the release carries the id
// of the noticeGiven event that was written first. A declined call stays unrecorded until it
// ends, across helper restarts and pauses (Codex 4b r1).

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function harness(opts: { logFails?: boolean; slowLog?: boolean } = {}) {
  const calls: string[] = [];
  const prompts: (CallPrompt | null)[] = [];
  const micHeld: boolean[] = [];
  let nextId = 1;
  const pendingLogs: (() => void)[] = [];
  const notice = createCallNotice({
    helper: {
      hold: () => void calls.push("hold"),
      release: (id: string) => void calls.push(`release ${id}`),
      discard: () => void calls.push("discard"),
    },
    logEvent: async (event: { kind: "noticeGiven" | "noticeDeclined"; detail: string }) => {
      calls.push(`log ${event.kind}`);
      if (opts.slowLog) await new Promise<void>((r) => pendingLogs.push(r));
      if (opts.logFails) throw new Error("backend down");
      return `event-${nextId++}`;
    },
    onPrompt: (p) => void prompts.push(p),
    onMicHeld: (held) => void micHeld.push(held),
    log: () => {},
  });
  const prompt = () => prompts.at(-1) ?? null;
  /** The current prompt, which must be the question. */
  const asking = () => {
    const p = prompt();
    if (p?.state !== "asking") throw new Error(`expected the question, got ${p?.state ?? "nothing"}`);
    return p;
  };
  const finishLog = async () => {
    pendingLogs.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { notice, calls, prompts, micHeld, prompt, asking, finishLog, mic: () => micHeld.at(-1) ?? false };
}

describe("createCallNotice", () => {
  it("holds the call and asks, without releasing anything", () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    expect(h.calls).toEqual(["hold"]);
    expect(h.mic()).toBe(true);
    expect(h.asking()).toMatchObject({ app: "us.zoom.xos", canExtend: true, deadline: Date.now() + NOTICE_TIMEOUT_MS });
  });

  it("I told them: writes noticeGiven first, then releases with its id, and the mic comes back", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await h.notice.given(h.asking().callId);
    expect(h.calls).toEqual(["hold", "log noticeGiven", "release event-1"]);
    expect(h.mic()).toBe(false);
    expect(h.prompt()).toBeNull();
  });

  it("Don't record this call: discards, and keeps the rest of the call unrecorded until it ends", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await h.notice.declined(h.asking().callId);
    expect(h.calls).toEqual(["hold", "log noticeDeclined", "discard", "hold"]);
    expect(h.mic()).toBe(true);
    expect(h.prompt()).toBeNull();
    h.notice.callEnded();
    expect(h.calls.at(-1)).toBe("discard");
    expect(h.mic()).toBe(false);
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
  });

  it("no answer by the deadline: discards, warns, and keeps the call unrecorded", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS);
    expect(h.calls).toEqual(["hold", "log noticeDeclined", "discard", "hold"]);
    expect(h.prompt()).toMatchObject({ state: "timedOut" });
    expect(h.mic()).toBe(true);
    h.notice.dismiss();
    expect(h.prompt()).toBeNull();
  });

  it("gives one extension, and only one", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    const id = h.asking().callId;
    const first = h.asking().deadline;
    h.notice.extend(id);
    expect(h.asking()).toMatchObject({ canExtend: false, deadline: first + EXTEND_MS });
    h.notice.extend(id);
    expect(h.asking().deadline).toBe(first + EXTEND_MS);
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS);
    expect(h.calls).toEqual(["hold"]);
    await vi.advanceTimersByTimeAsync(EXTEND_MS);
    expect(h.calls).toContain("discard");
  });

  it("ignores an answer for another call", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await h.notice.given("call-that-was-never-asked");
    expect(h.calls).toEqual(["hold"]);
  });

  it("can still be answered after the call ended, while the deadline holds", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    const id = h.asking().callId;
    h.notice.callEnded();
    expect(h.asking().callId).toBe(id);
    await h.notice.given(id);
    expect(h.calls).toEqual(["hold", "log noticeGiven", "release event-1"]);
    expect(h.mic()).toBe(false);
  });

  it("a notice that can't be written means the call is not recorded", async () => {
    const h = harness({ logFails: true });
    h.notice.callStarted("us.zoom.xos");
    await h.notice.given(h.asking().callId);
    expect(h.calls).toEqual(["hold", "log noticeGiven", "discard", "hold"]);
    expect(h.prompt()).toMatchObject({ state: "failed" });
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
  });

  it("a helper command that throws is logged, and the call is still asked about", () => {
    const logs: string[] = [];
    const prompts: (CallPrompt | null)[] = [];
    const notice = createCallNotice({
      helper: {
        hold: () => {
          throw new Error("The capture helper is not running");
        },
        release: () => {},
        discard: () => {},
      },
      logEvent: async () => "event-1",
      onPrompt: (p) => void prompts.push(p),
      onMicHeld: () => {},
      log: (m) => void logs.push(m),
    });
    notice.callStarted("us.zoom.xos");
    expect(logs.some((l) => l.includes("not running"))).toBe(true);
    expect(prompts.at(-1)).toMatchObject({ state: "asking" });
  });
});

// Codex 4b r1 P1: a call that starts while an earlier one is unresolved must get its own
// notice, and the earlier answer must never cover it.
describe("createCallNotice, a second call before the first is resolved", () => {
  it("an unanswered earlier call is dropped, and the new one is asked about on its own", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    const first = h.asking().callId;
    h.notice.callEnded();
    h.notice.callStarted("com.google.Chrome");
    await vi.advanceTimersByTimeAsync(0);
    // Held apart first, so not a sample of the second call is in the first's hold.
    expect(h.calls).toEqual(["hold", "hold", "log noticeDeclined", "discard"]);
    expect(h.asking()).toMatchObject({ app: "com.google.Chrome" });
    expect(h.asking().callId).not.toBe(first);
    await h.notice.given(first);
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
    expect(h.mic()).toBe(true);
  });

  it("a yes being written when the next call starts releases the first call only", async () => {
    const h = harness({ slowLog: true });
    h.notice.callStarted("us.zoom.xos");
    const answered = h.notice.given(h.asking().callId);
    h.notice.callEnded();
    h.notice.callStarted("com.google.Chrome");
    expect(h.calls).toEqual(["hold", "log noticeGiven", "hold"]);
    await h.finishLog();
    await answered;
    expect(h.calls).toEqual(["hold", "log noticeGiven", "hold", "release event-1"]);
    expect(h.asking()).toMatchObject({ app: "com.google.Chrome" });
    expect(h.mic()).toBe(true);
  });

  it("a no being written when the next call starts drops the first call only", async () => {
    const h = harness({ slowLog: true });
    h.notice.callStarted("us.zoom.xos");
    const answered = h.notice.declined(h.asking().callId);
    h.notice.callEnded();
    h.notice.callStarted("com.google.Chrome");
    await h.finishLog();
    await answered;
    expect(h.calls).toEqual(["hold", "log noticeDeclined", "hold", "discard"]);
    expect(h.asking()).toMatchObject({ app: "com.google.Chrome" });
    expect(h.mic()).toBe(true);
  });
});

// Codex 4b r1 P1: a helper retry, a pause, or a restart must not forget a decision.
describe("createCallNotice, across helper restarts", () => {
  it("a helper starting while a call is declined starts held, and the call stays unrecorded", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await h.notice.declined(h.asking().callId);
    expect(h.notice.helperStarting()).toBe(true);
    expect(h.mic()).toBe(true);
    h.notice.callEnded();
    expect(h.calls.at(-1)).toBe("discard");
    expect(h.mic()).toBe(false);
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
  });

  it("a helper starting while a call is being asked about starts held; the answer releases its audio", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    expect(h.notice.helperStarting()).toBe(true);
    await h.notice.given(h.asking().callId);
    expect(h.calls).toEqual(["hold", "log noticeGiven", "release event-1"]);
  });

  it("only the newest call survives a restart; an older one can't be released into the new helper", async () => {
    const h = harness({ slowLog: true });
    h.notice.callStarted("us.zoom.xos");
    const answered = h.notice.given(h.asking().callId);
    h.notice.callEnded();
    h.notice.callStarted("com.google.Chrome");
    expect(h.notice.helperStarting()).toBe(true);
    await h.finishLog();
    await answered;
    // The first call's audio went with the old helper; nothing of it is in the new one.
    expect(h.calls).toEqual(["hold", "log noticeGiven", "hold"]);
    expect(h.asking()).toMatchObject({ app: "com.google.Chrome" });
  });

  it("a helper starting with no call, or a told one, starts unheld", async () => {
    const h = harness();
    expect(h.notice.helperStarting()).toBe(false);
    h.notice.callStarted("us.zoom.xos");
    await h.notice.given(h.asking().callId);
    expect(h.notice.helperStarting()).toBe(false);
  });

  it("the deadline keeps running while the recorder is stopped", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    h.notice.helperStarting();
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS);
    expect(h.prompt()).toMatchObject({ state: "timedOut" });
  });
});

// The tray and the app say "Call — not saved yet" only while the question is open.
describe("statusWithCall", () => {
  const open: CallPrompt = { state: "asking", callId: "c", app: "us.zoom.xos", deadline: 1, canExtend: true };
  it("marks Recording as held while the question is open", () => {
    expect(statusWithCall({ status: "recording" }, open)).toEqual({ status: "recording", call: "held" });
  });
  it("leaves every other case alone", () => {
    expect(statusWithCall({ status: "recording" }, null)).toEqual({ status: "recording" });
    expect(statusWithCall({ status: "recording" }, { state: "timedOut", callId: "c" })).toEqual({ status: "recording" });
    expect(statusWithCall({ status: "paused" }, open)).toEqual({ status: "paused" });
  });
});
