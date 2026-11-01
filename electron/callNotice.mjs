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
// WHY helper commands are caught: a command throws only when no helper is running, and then
// nothing is being recorded either; the supervisor fails capture on a broken channel itself.

const MIN = 60_000;
// Spec: NOTICE_TIMEOUT_MIN = 15, with one extension (2.2.1); the helper's hold cap matches.
export const NOTICE_TIMEOUT_MS = 15 * MIN;
export const EXTEND_MS = 15 * MIN;

export function createCallNotice({ helper, logEvent, onPrompt, onMicHeld, log }) {
  // idle | asking | giving | declining | told | dropping. `ended`: the call ended while asked.
  let state = { kind: "idle" };
  let timer = null;
  let seq = 0;
  let micHeld = false;

  const setMicHeld = (held) => {
    if (held === micHeld) return;
    micHeld = held;
    onMicHeld(held);
  };

  const command = (name, ...args) => {
    try {
      helper[name](...args);
      return true;
    } catch (err) {
      log(`call notice: could not ${name} the call (${err?.message ?? err})`);
      return false;
    }
  };

  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };

  const ask = () => {
    onPrompt({ state: "asking", callId: state.callId, app: state.app, deadline: state.deadline, canExtend: state.canExtend });
  };

  const arm = () => {
    clearTimer();
    const callId = state.callId;
    timer = setTimeout(() => void drop(callId, "timedOut"), Math.max(0, state.deadline - Date.now()));
  };

  /** Drop what is held; keep holding to drop the rest while the call goes on. */
  async function drop(callId, why) {
    if (state.callId !== callId || state.kind !== "asking") return;
    clearTimer();
    const ended = state.ended;
    state = { kind: "declining", callId, ended };
    const detail = why === "timedOut" ? "no answer within the notice deadline" : "James chose not to record this call";
    try {
      await logEvent({ kind: "noticeDeclined", detail });
    } catch (err) {
      log(`call notice: could not record that the notice was declined (${err?.message ?? err})`);
    }
    if (state.callId !== callId) return;
    finishDrop(callId, state.ended || ended);
    onPrompt(why === "timedOut" ? { state: "timedOut", callId } : null);
  }

  function finishDrop(callId, ended) {
    command("discard");
    if (ended) {
      state = { kind: "idle" };
      setMicHeld(false);
    } else {
      command("hold");
      state = { kind: "dropping", callId };
    }
  }

  return {
    callStarted(app) {
      if (state.kind !== "idle") return;
      if (!command("hold")) return;
      seq += 1;
      state = {
        kind: "asking",
        callId: `call-${seq}-${Date.now()}`,
        app,
        deadline: Date.now() + NOTICE_TIMEOUT_MS,
        canExtend: true,
        ended: false,
      };
      setMicHeld(true);
      arm();
      ask();
    },

    callEnded() {
      switch (state.kind) {
        case "asking":
        case "giving":
        case "declining":
          state.ended = true;
          return;
        case "told":
          state = { kind: "idle" };
          return;
        case "dropping":
          command("discard");
          state = { kind: "idle" };
          setMicHeld(false);
          return;
        default:
      }
    },

    async given(callId) {
      if (state.kind !== "asking" || state.callId !== callId) return;
      clearTimer();
      state = { kind: "giving", callId, ended: state.ended };
      let noticeId;
      try {
        noticeId = await logEvent({ kind: "noticeGiven", detail: "James told everyone on the call it is being recorded" });
      } catch (err) {
        log(`call notice: could not record the notice, so the call is not recorded (${err?.message ?? err})`);
        if (state.callId !== callId) return;
        finishDrop(callId, state.ended);
        onPrompt({ state: "failed", callId });
        return;
      }
      // The recorder stopped meanwhile: the helper dropped what it held when it stopped.
      if (state.callId !== callId) return;
      command("release", noticeId);
      state = state.ended ? { kind: "idle" } : { kind: "told", callId };
      setMicHeld(false);
      onPrompt(null);
    },

    declined: (callId) => drop(callId, "declined"),

    extend(callId) {
      if (state.kind !== "asking" || state.callId !== callId || !state.canExtend) return;
      state.deadline += EXTEND_MS;
      state.canExtend = false;
      arm();
      ask();
    },

    /** Close a "not recorded" warning. */
    dismiss() {
      onPrompt(null);
    },

    /** The recorder left Recording: its helper drops anything held when it stops. */
    recorderStopped() {
      clearTimer();
      if (state.kind === "idle") return;
      state = { kind: "idle" };
      setMicHeld(false);
      onPrompt(null);
    },

    micHeld: () => micHeld,
  };
}
