import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTEND_MS, NOTICE_TIMEOUT_MS, createCallNotice, statusWithCall, type CallPrompt } from "../electron/callNotice.mjs";

// WHAT: the call notice (plan PR 4b, spec R5 / F3). WHY tested: this is where "no call audio
// is written without a notice" is decided. Without a notice the helper is only ever told to
// discard, the mic stays off, and nothing is released; with one, the release carries the id
// of the noticeGiven event that was written first.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function harness(opts: { logFails?: boolean } = {}) {
  const calls: string[] = [];
  const prompts: (CallPrompt | null)[] = [];
  const micHeld: boolean[] = [];
  let nextId = 1;
  const notice = createCallNotice({
    helper: {
      hold: () => void calls.push("hold"),
      release: (id: string) => void calls.push(`release ${id}`),
      discard: () => void calls.push("discard"),
    },
    logEvent: async (event: { kind: "noticeGiven" | "noticeDeclined"; detail: string }) => {
      calls.push(`log ${event.kind}`);
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
  return { notice, calls, prompts, micHeld, prompt, asking };
}

describe("createCallNotice", () => {
  it("holds the call and asks, without releasing anything", () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    expect(h.calls).toEqual(["hold"]);
    expect(h.micHeld.at(-1)).toBe(true);
    expect(h.prompt()).toMatchObject({ state: "asking", app: "us.zoom.xos", canExtend: true });
    expect(h.asking().deadline).toBe(Date.now() + NOTICE_TIMEOUT_MS);
  });

  it("I told them: writes noticeGiven first, then releases with its id, and the mic comes back", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    const id = h.prompt()!.callId;
    await h.notice.given(id);
    expect(h.calls).toEqual(["hold", "log noticeGiven", "release event-1"]);
    expect(h.micHeld.at(-1)).toBe(false);
    expect(h.prompt()).toBeNull();
  });

  it("Don't record this call: discards, and keeps the rest of the call unrecorded until it ends", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await h.notice.declined(h.prompt()!.callId);
    expect(h.calls).toEqual(["hold", "log noticeDeclined", "discard", "hold"]);
    expect(h.micHeld.at(-1)).toBe(true);
    expect(h.prompt()).toBeNull();
    h.notice.callEnded();
    expect(h.calls.at(-1)).toBe("discard");
    expect(h.micHeld.at(-1)).toBe(false);
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
  });

  it("no answer in 15 minutes: discards, warns, and keeps the call unrecorded", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS);
    expect(h.calls).toEqual(["hold", "log noticeDeclined", "discard", "hold"]);
    expect(h.prompt()).toMatchObject({ state: "timedOut" });
    expect(h.micHeld.at(-1)).toBe(true);
    h.notice.dismiss();
    expect(h.prompt()).toBeNull();
  });

  it("gives one extension, and only one", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    const id = h.prompt()!.callId;
    const first = h.asking().deadline;
    h.notice.extend(id);
    expect(h.prompt()).toMatchObject({ state: "asking", canExtend: false, deadline: first + EXTEND_MS });
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
    const id = h.prompt()!.callId;
    h.notice.callEnded();
    expect(h.prompt()).toMatchObject({ state: "asking" });
    await h.notice.given(id);
    expect(h.calls).toEqual(["hold", "log noticeGiven", "release event-1"]);
  });

  it("a told call ends without any further command", async () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    await h.notice.given(h.prompt()!.callId);
    h.notice.callStarted("us.zoom.xos");
    h.notice.callEnded();
    expect(h.calls).toEqual(["hold", "log noticeGiven", "release event-1"]);
  });

  it("a notice that can't be written means the call is not recorded", async () => {
    const h = harness({ logFails: true });
    h.notice.callStarted("us.zoom.xos");
    await h.notice.given(h.prompt()!.callId);
    expect(h.calls).toEqual(["hold", "log noticeGiven", "discard", "hold"]);
    expect(h.prompt()).toMatchObject({ state: "failed" });
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
  });

  it("forgets the call when the recorder stops (the helper drops what it held itself)", () => {
    const h = harness();
    h.notice.callStarted("us.zoom.xos");
    h.notice.recorderStopped();
    expect(h.calls).toEqual(["hold"]);
    expect(h.prompt()).toBeNull();
    expect(h.micHeld.at(-1)).toBe(false);
    h.notice.callEnded();
    expect(h.calls).toEqual(["hold"]);
  });

  it("a helper command that throws ends the ask without recording the call", () => {
    const calls: string[] = [];
    const notice = createCallNotice({
      helper: {
        hold: () => {
          throw new Error("The capture helper is not running");
        },
        release: () => void calls.push("release"),
        discard: () => void calls.push("discard"),
      },
      logEvent: async () => "event-1",
      onPrompt: () => {},
      onMicHeld: () => {},
      log: (m) => void calls.push(m),
    });
    notice.callStarted("us.zoom.xos");
    expect(calls.some((c) => c.includes("not running"))).toBe(true);
    expect(calls).not.toContain("release");
  });
});

// The tray and the app say "Call — not saved yet" only while the question is open.
describe("statusWithCall", () => {
  const asking: CallPrompt = { state: "asking", callId: "c", app: "us.zoom.xos", deadline: 1, canExtend: true };
  it("marks Recording as held while the question is open", () => {
    expect(statusWithCall({ status: "recording" }, asking)).toEqual({ status: "recording", call: "held" });
  });
  it("leaves every other case alone", () => {
    expect(statusWithCall({ status: "recording" }, null)).toEqual({ status: "recording" });
    expect(statusWithCall({ status: "recording" }, { state: "timedOut", callId: "c" })).toEqual({ status: "recording" });
    expect(statusWithCall({ status: "paused" }, asking)).toEqual({ status: "paused" });
  });
});
