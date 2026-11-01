// WHAT: the call notice (plan PR 4b, spec R5 / F3). When a call starts, the helper holds its
// audio in memory and the mic stops; James is asked to tell everyone it is being recorded.
// "I told them" writes a noticeGiven event and only then releases the held audio, with that
// event's id, after which the call is recorded as usual. "Don't record this call", no answer
// within the deadline, or a notice that can't be written keep it held, unwritten, and drop it
// when the call ends.
// WHY the mic stops instead of holding: the helper holds system audio (PR 4a); the mic's own
// segments are cut by its page, and a hold there would mean splitting a live WebM. Stopping
// keeps the same guarantee (nothing of the call on disk before the notice); what is lost is
// James's own voice before he answers (plan.md Deviations, 4b).
// WHY every helper starts held, and calls belong to one helper (Codex review of PR 4b, rounds 1
// and 2): a helper can't know whether a call is going on until its first audio-use report, and
// a call seen by a new helper can't be proven to be the one answered before. So each helper
// holds from its first sample until that report; a call already going on keeps that hold as
// its own and is asked about again; with none, the hold is cleared into ordinary system audio.
// An old helper's calls, and answers that arrive for them late, do nothing.
// WHY a list of calls: a call can start while an earlier one is still being answered. Each is
// held apart and answered on its own; the helper resolves held calls oldest first, so each
// call's command waits for the one before it.

const MIN = 60_000;
// Spec: NOTICE_TIMEOUT_MIN = 15, with one extension (2.2.1); the helper's hold cap matches.
export const NOTICE_TIMEOUT_MS = 15 * MIN;
export const EXTEND_MS = 15 * MIN;

// Calls whose audio the helper is holding: waiting for an answer, being answered, or declined.
const HELD = new Set(["asking", "giving", "declining", "dropping"]);

export function createCallNotice({ helper, logEvent, onPrompt, onMicHeld, log }) {
  /** Oldest first: { callId, gen, apps, kind, ended, deadline, canExtend, timer, ready, done, finished } */
  let calls = [];
  // Which helper the calls belong to; bumped when one goes and when one starts.
  let gen = 0;
  // "stopped" | "starting" (held until the first report) | "running"
  let phase = "stopped";
  // The startup hold is still waiting: no call has taken it as its own yet.
  let startupHold = false;
  let warning = null;
  let seq = 0;
  let micHeld = true;
  let prompt = null;

  const live = (call) => call.gen === gen;
  const newest = () => calls.at(-1) ?? null;
  const find = (callId) => calls.find((c) => c.callId === callId && live(c)) ?? null;

  function command(name, ...args) {
    try {
      helper[name](...args);
    } catch (err) {
      log(`call notice: could not ${name} the call (${err?.message ?? err})`);
    }
  }

  function refresh() {
    const held = phase !== "running" || calls.some((c) => HELD.has(c.kind));
    if (held !== micHeld) {
      micHeld = held;
      onMicHeld(held);
    }
    const asking = [...calls].reverse().find((c) => c.kind === "asking");
    const next = asking
      ? { state: "asking", callId: asking.callId, app: asking.app, deadline: asking.deadline, canExtend: asking.canExtend }
      : warning;
    if (JSON.stringify(next) === JSON.stringify(prompt)) return;
    prompt = next;
    onPrompt(next);
  }

  function remove(call) {
    clearTimeout(call.timer);
    calls = calls.filter((c) => c !== call);
  }

  function arm(call) {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => void drop(call, "timedOut"), Math.max(0, call.deadline - Date.now()));
  }

  /**
   * Run this call's resolving command once every earlier call has issued its own, so the
   * helper (which resolves the oldest held call) applies it to this call. A call from an
   * earlier helper has nothing in this one to resolve.
   */
  function resolveInHelper(call, name, ...args) {
    const run = () => {
      if (live(call)) command(name, ...args);
      call.done();
    };
    // Nothing ahead of it: now. Otherwise once the call before it has issued its own.
    if (call.readyNow) {
      run();
      return Promise.resolve();
    }
    return call.ready.then(run);
  }

  /** Declined, timed out, or a notice that couldn't be written: held, unwritten, until it ends. */
  async function drop(call, why) {
    if (call.kind !== "asking" || !live(call)) return;
    clearTimeout(call.timer);
    call.kind = "declining";
    const detail =
      why === "timedOut"
        ? "no answer within the notice deadline"
        : why === "superseded"
          ? "a new call began before the notice was answered"
          : "James chose not to record this call";
    try {
      await logEvent({ kind: "noticeDeclined", detail });
    } catch (err) {
      log(`call notice: could not record that the notice was declined (${err?.message ?? err})`);
    }
    if (!live(call)) return;
    settleDropped(call);
    if (why === "timedOut") warning = { state: "timedOut", callId: call.callId };
    refresh();
  }

  function settleDropped(call) {
    // Ended (or superseded): drop it now. Going on: keep holding; it is dropped when it ends.
    if (call.ended || call !== newest()) {
      void resolveInHelper(call, "discard").then(() => {
        remove(call);
        refresh();
      });
      // Resolved now when nothing was ahead of it.
      if (call.readyNow) remove(call);
      return;
    }
    call.kind = "dropping";
  }

  function newCall(app, { holdCommand }) {
    const before = [...calls].reverse().find((c) => HELD.has(c.kind)) ?? null;
    if (holdCommand) command("hold");
    let done;
    const finished = new Promise((resolve) => {
      done = resolve;
    });
    seq += 1;
    const call = {
      callId: `call-${seq}-${Date.now()}`,
      gen,
      app,
      apps: new Set([app]),
      kind: "asking",
      ended: false,
      deadline: Date.now() + NOTICE_TIMEOUT_MS,
      canExtend: true,
      timer: null,
      ready: before ? before.finished : Promise.resolve(),
      readyNow: !before,
      done,
      finished,
    };
    if (before) before.finished.then(() => void (call.readyNow = true));
    calls.push(call);
    warning = null;
    arm(call);
    return { call, before };
  }

  return {
    /** A new helper is starting: it always starts held, and the old helper's calls are gone. */
    helperStarting() {
      gen += 1;
      for (const c of calls) clearTimeout(c.timer);
      calls = [];
      phase = "starting";
      startupHold = true;
      refresh();
      return true;
    },

    /** The helper stopped: its held audio went with it, and so do its calls. */
    helperGone() {
      gen += 1;
      for (const c of calls) clearTimeout(c.timer);
      calls = [];
      phase = "stopped";
      startupHold = false;
      refresh();
    },

    /** The helper's first audio-use report is in. With no call, the startup hold is ordinary audio. */
    audioReady() {
      if (phase !== "starting") return;
      phase = "running";
      if (startupHold) {
        startupHold = false;
        command("clear");
      }
      refresh();
    },

    callAppStarted(app) {
      if (phase === "stopped") return;
      // A call going on when the helper started: the startup hold is already holding it.
      if (startupHold) {
        startupHold = false;
        newCall(app, { holdCommand: false });
        refresh();
        return;
      }
      const current = [...calls].reverse().find((c) => !c.ended) ?? null;
      if (current && current.kind !== "told") {
        // Joining a call that is unanswered, being answered, or declined: already held.
        current.apps.add(app);
        return;
      }
      if (current && current.apps.has(app)) return;
      // A new call, or a new app joining a told one: held apart and asked about on its own.
      const { before } = newCall(app, { holdCommand: true });
      // An earlier call nobody answered is dropped: its answer can't cover this one.
      if (before?.kind === "asking") {
        before.ended = true;
        void drop(before, "superseded");
      }
      refresh();
    },

    callEnded() {
      for (const call of [...calls]) {
        if (call.ended) continue;
        call.ended = true;
        if (call.kind === "told") remove(call);
        else if (call.kind === "dropping") settleDropped(call);
      }
      refresh();
    },

    async given(callId) {
      const call = find(callId);
      if (!call || call.kind !== "asking") return;
      clearTimeout(call.timer);
      call.kind = "giving";
      let noticeId;
      try {
        noticeId = await logEvent({ kind: "noticeGiven", detail: "James told everyone on the call it is being recorded" });
      } catch (err) {
        log(`call notice: could not record the notice, so the call is not recorded (${err?.message ?? err})`);
        if (!live(call)) return;
        call.kind = "declining";
        settleDropped(call);
        warning = { state: "failed", callId };
        refresh();
        return;
      }
      if (!live(call)) return;
      await resolveInHelper(call, "release", noticeId);
      if (!live(call)) return;
      if (call.ended || call !== newest()) remove(call);
      else call.kind = "told";
      refresh();
    },

    declined: (callId) => {
      const call = find(callId);
      return call ? drop(call, "declined") : Promise.resolve();
    },

    extend(callId) {
      const call = find(callId);
      if (!call || call.kind !== "asking" || !call.canExtend) return;
      call.deadline += EXTEND_MS;
      call.canExtend = false;
      arm(call);
      refresh();
    },

    /** Close a "not recorded" warning. */
    dismiss() {
      warning = null;
      refresh();
    },

    micHeld: () => micHeld,
  };
}

/** The status the tray and the app show: Recording is "held" while the question is open. */
export function statusWithCall(status, prompt) {
  return status.status === "recording" && prompt?.state === "asking" ? { ...status, call: "held" } : status;
}
