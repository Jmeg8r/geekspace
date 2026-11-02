import { afterEach, describe, expect, it, vi } from "vitest";
import { promptAfterFetch, remainingLabel } from "../src/lib/callPrompt";
import { answerCall, onCallPrompt } from "../src/lib/dayRecorderBridge";

// WHAT: the call prompt's countdown and the page's answers (plan PR 4b). WHY: the notice
// timeout must be visible (spec, WCAG 2.2.1), and an answer that fails must come back as an
// error the prompt can show, so James never believes a call is recorded when it is not.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remainingLabel", () => {
  it("counts down in minutes and seconds, and never below zero", () => {
    expect(remainingLabel(15 * 60_000, 0)).toBe("15:00");
    expect(remainingLabel(61_500, 0)).toBe("1:02");
    expect(remainingLabel(1_000, 5_000)).toBe("0:00");
  });
});

describe("answerCall", () => {
  it("sends the answer with its call id", async () => {
    const noticeGiven = vi.fn(async () => ({ ok: true, data: undefined }));
    vi.stubGlobal("window", { geekspace: { dayRecorder: { noticeGiven } } });
    expect(await answerCall("given", "call-1")).toEqual({ ok: true, data: undefined });
    expect(noticeGiven).toHaveBeenCalledWith("call-1");
  });

  it("says the desktop app is needed outside it", async () => {
    vi.stubGlobal("window", {});
    expect(await answerCall("declined", "call-1")).toEqual({ ok: false, error: "The Day Recorder needs the desktop app." });
  });
});

describe("onCallPrompt", () => {
  it("delivers call events only", () => {
    let listener: ((e: { type: string; prompt?: { state: string } | null }) => void) | null = null;
    vi.stubGlobal("window", {
      geekspace: {
        dayRecorder: {
          onEvent: (cb: typeof listener) => {
            listener = cb;
            return () => {};
          },
        },
      },
    });
    const seen: (string | null)[] = [];
    onCallPrompt((p) => void seen.push(p?.state ?? null));
    listener!({ type: "status" });
    listener!({ type: "call", prompt: { state: "asking" } });
    listener!({ type: "call", prompt: null });
    expect(seen).toEqual(["asking", null]);
  });
});

// Codex 4b r7 P2: the first fetch could answer after a newer event (a closed prompt, null)
// and bring back the older question.
describe("promptAfterFetch", () => {
  const asking = { state: "asking" as const, callId: "call-1", app: "us.zoom.xos", deadline: 1, canExtend: true };
  it("takes the fetched prompt when no event came first", () => {
    expect(promptAfterFetch({ heard: false, current: null }, asking)).toEqual(asking);
  });
  it("keeps what an event said, even null, when it came first", () => {
    expect(promptAfterFetch({ heard: true, current: null }, asking)).toBeNull();
  });
});
