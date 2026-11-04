import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTEND_MS, NOTICE_TIMEOUT_MS, createCallNotice, statusWithCall, type CallPrompt } from "../electron/callNotice.mjs";

// WHAT: the call notice (plan PR 4b, spec R5 / F3). WHY tested: this is where "no call audio
// is written without a notice" is decided. Every helper starts held until its first audio-use
// report; a call is held from its first sample; only "I told them" releases it, with the id of
// the noticeGiven event written first; everything else keeps it held until it is dropped.
// Calls belong to one helper: a new helper asks again (Codex 4b r2).

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
      release: (id: string) => void calls.push(`release ${id}`),
      discard: () => void calls.push("discard"),
      clear: () => void calls.push("clear"),
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
  /** A helper that has started and reported, with no call going on. */
  const running = () => {
    expect(notice.helperStarting()).toBe(true);
    notice.audioReady();
    calls.length = 0;
  };
  /** The helper held a call app's audio on its own (Codex 4b r3): "held" marks when. */
  const held = (app: string) => {
    calls.push("held");
    notice.callHeld(app);
  };
  return { notice, calls, prompts, micHeld, prompt, asking, finishLog, running, held, mic: () => micHeld.at(-1) ?? false };
}

describe("createCallNotice, a helper starting", () => {
  it("always starts held, keeps the mic off until the first report, then clears the hold", () => {
    const h = harness();
    expect(h.notice.helperStarting()).toBe(true);
    expect(h.notice.micHeld()).toBe(true);
    h.notice.audioReady();
    expect(h.calls).toEqual(["clear"]);
    expect(h.notice.micHeld()).toBe(false);
  });

  it("a call already going on keeps the startup hold as its own, and is asked about", async () => {
    const h = harness();
    h.notice.helperStarting();
    h.notice.callAppStarted("us.zoom.xos");
    h.notice.audioReady();
    expect(h.calls).toEqual([]);
    expect(h.asking()).toMatchObject({ app: "us.zoom.xos" });
    expect(h.notice.micHeld()).toBe(true);
    await h.notice.given(h.asking().callId);
    expect(h.calls).toEqual(["log noticeGiven", "release event-1"]);
    expect(h.notice.micHeld()).toBe(false);
  });

  // Codex 4b r2 P1: decisions do not cross helpers. A call still going on is asked about again.
  it("forgets the old helper's calls, and their late answers do nothing", async () => {
    const h = harness({ slowLog: true });
    h.running();
    h.held("us.zoom.xos");
    const answered = h.notice.given(h.asking().callId);
    h.notice.helperGone();
    expect(h.prompt()).toBeNull();
    h.notice.helperStarting();
    await h.finishLog();
    await answered;
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
    h.notice.callAppStarted("us.zoom.xos");
    h.notice.audioReady();
    expect(h.asking()).toMatchObject({ app: "us.zoom.xos" });
  });

  it("a declined call is asked about again after a restart, and stays held until answered", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    await h.notice.declined(h.asking().callId);
    h.notice.helperGone();
    expect(h.notice.helperStarting()).toBe(true);
    h.notice.callAppStarted("us.zoom.xos");
    h.notice.audioReady();
    expect(h.asking()).toMatchObject({ app: "us.zoom.xos" });
    expect(h.notice.micHeld()).toBe(true);
  });
});

describe("createCallNotice, a call", () => {
  it("holds the call and asks, without releasing anything", () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    expect(h.calls).toEqual(["held"]);
    expect(h.mic()).toBe(true);
    expect(h.asking()).toMatchObject({ app: "us.zoom.xos", canExtend: true, deadline: Date.now() + NOTICE_TIMEOUT_MS });
  });

  it("I told them: writes noticeGiven first, then releases with its id, and the mic comes back", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    await h.notice.given(h.asking().callId);
    expect(h.calls).toEqual(["held", "log noticeGiven", "release event-1"]);
    expect(h.mic()).toBe(false);
    expect(h.prompt()).toBeNull();
  });

  // Codex 4b r2 P1: no discard-then-hold gap; the declined call simply stays held.
  it("Don't record this call: keeps it held, unwritten, and drops it when it ends", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    await h.notice.declined(h.asking().callId);
    expect(h.calls).toEqual(["held", "log noticeDeclined"]);
    expect(h.mic()).toBe(true);
    expect(h.prompt()).toBeNull();
    h.notice.callEnded();
    expect(h.calls).toEqual(["held", "log noticeDeclined", "discard"]);
    expect(h.mic()).toBe(false);
  });

  it("no answer by the deadline: keeps it held, warns, and drops it when it ends", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS);
    expect(h.calls).toEqual(["held", "log noticeDeclined"]);
    expect(h.prompt()).toMatchObject({ state: "timedOut" });
    h.notice.dismiss();
    expect(h.prompt()).toBeNull();
    h.notice.callEnded();
    expect(h.calls.at(-1)).toBe("discard");
  });

  it("gives one extension, and only one", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    const id = h.asking().callId;
    const first = h.asking().deadline;
    h.notice.extend(id);
    expect(h.asking()).toMatchObject({ canExtend: false, deadline: first + EXTEND_MS });
    h.notice.extend(id);
    expect(h.asking().deadline).toBe(first + EXTEND_MS);
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS);
    expect(h.calls).toEqual(["held"]);
    await vi.advanceTimersByTimeAsync(EXTEND_MS);
    expect(h.calls).toContain("log noticeDeclined");
  });

  it("ignores an answer for another call", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    await h.notice.given("call-that-was-never-asked");
    expect(h.calls).toEqual(["held"]);
  });

  it("can still be answered after the call ended, while the deadline holds", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    const id = h.asking().callId;
    h.notice.callEnded();
    expect(h.asking().callId).toBe(id);
    await h.notice.given(id);
    expect(h.calls).toEqual(["held", "log noticeGiven", "release event-1"]);
    expect(h.mic()).toBe(false);
  });

  it("a notice that can't be written means the call is not recorded", async () => {
    const h = harness({ logFails: true });
    h.running();
    h.held("us.zoom.xos");
    await h.notice.given(h.asking().callId);
    expect(h.calls).toEqual(["held", "log noticeGiven"]);
    expect(h.prompt()).toMatchObject({ state: "failed" });
    expect(h.mic()).toBe(true);
    h.notice.callEnded();
    expect(h.calls.at(-1)).toBe("discard");
  });

  it("an app joining an unanswered call is part of that call: one answer resolves both holds", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    const id = h.asking().callId;
    h.held("com.tinyspeck.slackmacgap");
    expect(h.asking().callId).toBe(id);
    await h.notice.given(id);
    expect(h.calls).toEqual(["held", "held", "log noticeGiven", "release event-1", "release event-1"]);
    expect(h.mic()).toBe(false);
  });

  // Codex 4b r2 P1: a new app can't ride on an earlier "I told them".
  it("an app joining a told call is a new call, held and asked about", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    await h.notice.given(h.asking().callId);
    h.held("com.microsoft.teams2");
    expect(h.calls).toEqual(["held", "log noticeGiven", "release event-1", "held"]);
    expect(h.asking()).toMatchObject({ app: "com.microsoft.teams2" });
    expect(h.mic()).toBe(true);
  });

  it("a helper command that throws is logged", async () => {
    const logs: string[] = [];
    const prompts: (CallPrompt | null)[] = [];
    const notice = createCallNotice({
      helper: {
        release: () => {
          throw new Error("The capture helper is not running");
        },
        discard: () => {},
        clear: () => {},
      },
      logEvent: async () => "event-1",
      onPrompt: (p) => void prompts.push(p),
      onMicHeld: () => {},
      log: (m) => void logs.push(m),
    });
    notice.helperStarting();
    notice.audioReady();
    notice.callHeld("us.zoom.xos");
    const p = prompts.at(-1);
    if (p?.state !== "asking") throw new Error("expected the question");
    await notice.given(p.callId);
    expect(logs.some((l) => l.includes("not running"))).toBe(true);
  });
});

describe("createCallNotice, a second call before the first is resolved", () => {
  it("an unanswered earlier call is dropped, and the new one is asked about on its own", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    const first = h.asking().callId;
    h.notice.callEnded();
    h.held("com.google.Chrome");
    await vi.advanceTimersByTimeAsync(0);
    // Held apart first, so not a sample of the second call is in the first's hold.
    expect(h.calls).toEqual(["held", "held", "log noticeDeclined", "discard"]);
    expect(h.asking()).toMatchObject({ app: "com.google.Chrome" });
    await h.notice.given(first);
    expect(h.calls.filter((c) => c.startsWith("release"))).toEqual([]);
  });

  it("a yes being written when the next call starts releases the first call only", async () => {
    const h = harness({ slowLog: true });
    h.running();
    h.held("us.zoom.xos");
    const answered = h.notice.given(h.asking().callId);
    h.notice.callEnded();
    h.held("com.google.Chrome");
    await h.finishLog();
    await answered;
    expect(h.calls).toEqual(["held", "log noticeGiven", "held", "release event-1"]);
    expect(h.asking()).toMatchObject({ app: "com.google.Chrome" });
  });

  it("a no being written when the next call starts drops the first call only", async () => {
    const h = harness({ slowLog: true });
    h.running();
    h.held("us.zoom.xos");
    const answered = h.notice.declined(h.asking().callId);
    h.notice.callEnded();
    h.held("com.google.Chrome");
    await h.finishLog();
    await answered;
    expect(h.calls).toEqual(["held", "log noticeDeclined", "held", "discard"]);
    expect(h.asking()).toMatchObject({ app: "com.google.Chrome" });
  });
});

// Codex 4b r3: the helper holds a call app's audio itself, from before it was seen (P1 3), so
// a call is never answered by a notice given before its app joined (P1 1 and 2).
describe("createCallNotice, the helper's own holds", () => {
  it("[P1] an app starting while a yes is being written is a new call, asked about on its own", async () => {
    const h = harness({ slowLog: true });
    h.running();
    h.held("us.zoom.xos");
    const answered = h.notice.given(h.asking().callId);
    h.held("com.microsoft.teams2");
    expect(h.asking()).toMatchObject({ app: "com.microsoft.teams2" });
    await h.finishLog();
    await answered;
    expect(h.calls).toEqual(["held", "log noticeGiven", "held", "release event-1"]);
    expect(h.asking()).toMatchObject({ app: "com.microsoft.teams2" });
    expect(h.mic()).toBe(true);
  });

  it("[P1] an app that leaves and starts again after a yes is asked about again", async () => {
    const h = harness();
    h.running();
    h.held("us.zoom.xos");
    h.held("com.microsoft.teams2");
    await h.notice.given(h.asking().callId);
    expect(h.mic()).toBe(false);
    h.held("us.zoom.xos");
    expect(h.asking()).toMatchObject({ app: "us.zoom.xos" });
    expect(h.mic()).toBe(true);
  });

  it("after the first report, an app the detector sees starts nothing: the helper's hold does", () => {
    const h = harness();
    h.running();
    h.notice.callAppStarted("us.zoom.xos");
    expect(h.prompt()).toBeNull();
    expect(h.calls).toEqual([]);
    expect(h.mic()).toBe(false);
  });
});

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
