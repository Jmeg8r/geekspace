// WHAT: the call notice (plan PR 4b, spec R5 / F3). When a call starts, the helper holds its
// audio in memory and the mic stops; James is asked to tell everyone it is being recorded.
// "I told them" writes a noticeGiven event and only then releases the held audio, with that
// event's id, after which the call is recorded as usual. "Don't record this call", no answer
// within the deadline, or a notice that can't be written drop the held audio, and the rest of
// that call stays unrecorded until it ends.
// WHY the mic stops instead of holding: the helper holds system audio (PR 4a); the mic's own
// segments are cut by its page, and a hold there would mean splitting a live WebM. Stopping
// keeps the same guarantee (nothing of the call on disk before the notice); what is lost is
// James's own voice before he answers (plan.md Deviations, 4b).
// WHY a list of calls (Codex review of PR 4b): a call can start while an earlier one is still
// being answered. Each is held apart and answered on its own; the helper resolves held calls
// oldest first, so each call's command waits for the one before it.
// WHY decisions survive the helper: a retry, a pause or a restart replaces the helper, not the
// call. A helper started while the newest call is unanswered or declined starts held, and only
// that call carries into it; older calls' audio went with the old helper.

const MIN = 60_000;
// Spec: NOTICE_TIMEOUT_MIN = 15, with one extension (2.2.1); the helper's hold cap matches.
export const NOTICE_TIMEOUT_MS = 15 * MIN;
export const EXTEND_MS = 15 * MIN;

// Calls whose audio the helper is holding: waiting for an answer, being answered, or declined.
const HELD = new Set(["asking", "giving", "declining", "dropping"]);

export function createCallNotice({ helper, logEvent, onPrompt, onMicHeld, log }) {
  /** Oldest first: { callId, app, kind, ended, deadline, canExtend, timer, inHelper, ready, done } */
  let calls = [];
  let warning = null;
  let seq = 0;
  let micHeld = false;
  let prompt = null;

  const newest = () => calls.at(-1) ?? null;
  const find = (callId) => calls.find((c) => c.callId === callId) ?? null;

  function command(name, ...args) {
    try {
      helper[name](...args);
    } catch (err) {
      log(`call notice: could not ${name} the call (${err?.message ?? err})`);
    }
  }

  function refresh() {
    const held = calls.some((c) => HELD.has(c.kind));
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
   * helper (which resolves the oldest held call) applies it to this call. A call that is not
   * in the current helper has nothing there to resolve.
   */
  async function resolveInHelper(call, name, ...args) {
    await call.ready;
    if (call.inHelper) command(name, ...args);
    call.done();
  }

  /** Drop what is held; keep holding to drop the rest while the call goes on. */
  async function drop(call, why) {
    if (call.kind !== "asking") return;
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
    await settleDropped(call);
    if (why === "timedOut") warning = { state: "timedOut", callId: call.callId };
    refresh();
  }

  async function settleDropped(call) {
    await resolveInHelper(call, "discard");
    if (call.ended || call !== newest()) {
      remove(call);
      return;
    }
    // The call goes on: hold again, so the rest of it is dropped too when it ends.
    if (call.inHelper) command("hold");
    call.kind = "dropping";
    call.ready = Promise.resolve();
    call.done = () => {};
  }

  return {
    callStarted(app) {
      const current = newest();
      // The same call going on: the detector reports a call once, until it ends.
      if (current && !current.ended) return;
      // Hold the new call apart first, so not a sample of it is in an earlier call's hold.
      command("hold");
      const before = current && HELD.has(current.kind) ? current : null;
      let done;
      const finished = new Promise((resolve) => {
        done = resolve;
      });
      seq += 1;
      const call = {
        callId: `call-${seq}-${Date.now()}`,
        app,
        kind: "asking",
        ended: false,
        deadline: Date.now() + NOTICE_TIMEOUT_MS,
        canExtend: true,
        timer: null,
        inHelper: true,
        ready: before ? before.finished : Promise.resolve(),
        done,
        finished,
      };
      calls.push(call);
      warning = null;
      arm(call);
      // An earlier call nobody answered is dropped: its answer can't cover this one.
      if (before?.kind === "asking") void drop(before, "superseded");
      refresh();
    },

    callEnded() {
      const call = newest();
      if (!call || call.ended) return;
      call.ended = true;
      if (call.kind === "told") {
        remove(call);
      } else if (call.kind === "dropping") {
        // Nothing is ahead of a dropping call: it waited its turn when it was declined.
        if (call.inHelper) command("discard");
        remove(call);
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
        call.kind = "declining";
        await settleDropped(call);
        warning = { state: "failed", callId };
        refresh();
        return;
      }
      await resolveInHelper(call, "release", noticeId);
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

    /**
     * A new helper is starting. Returns whether it must start held: the newest call is still
     * held (unanswered, being answered, or declined). Only that call carries into it.
     */
    helperStarting() {
      const call = newest();
      for (const c of calls) c.inHelper = false;
      if (!call || !HELD.has(call.kind)) return false;
      call.inHelper = true;
      call.ready = Promise.resolve();
      return true;
    },

    micHeld: () => micHeld,
  };
}

/** The status the tray and the app show: Recording is "held" while the question is open. */
export function statusWithCall(status, prompt) {
  return status.status === "recording" && prompt?.state === "asking" ? { ...status, call: "held" } : status;
}
