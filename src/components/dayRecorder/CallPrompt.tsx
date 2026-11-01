import { useEffect, useRef, useState } from "react";
import { remainingLabel } from "../../lib/callPrompt";
import {
  answerCall,
  currentCallPrompt,
  dayRecorderAvailable,
  dismissCallWarning,
  onCallPrompt,
  type CallPrompt as Prompt,
} from "../../lib/dayRecorderBridge";

// WHAT: the call notice prompt (plan PR 4b, spec F3 and the UI table). While a call waits for
// its notice, this asks James to tell everyone, with a visible deadline and one extension.
// WHY not modal (spec, Accessibility 2.1.1 / 2.4.3): focus moves to it when it opens, but it
// never traps focus; James may be typing in the call's own app.

const BUTTON =
  "rounded-md border border-border px-2.5 py-1 text-[12.5px] text-ink hover:bg-hov focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

export function CallPrompt() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  // Busy for one call only: a slow answer for an earlier call never locks a newer prompt.
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    const off = onCallPrompt((p) => {
      setPrompt(p);
      setError(null);
    });
    void currentCallPrompt().then((r) => {
      if (!live) return;
      // An event that arrived first is newer than this answer.
      if (r.ok) setPrompt((current) => current ?? r.data);
      else if (dayRecorderAvailable()) setError(r.error);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const key = prompt ? `${prompt.callId}:${prompt.state}` : null;
  useEffect(() => {
    if (key) heading.current?.focus();
  }, [key]);

  const asking = prompt?.state === "asking";
  useEffect(() => {
    if (!asking) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [asking]);

  if (!prompt) {
    return error ? (
      <p role="alert" className="fixed bottom-5 left-5 z-[60] text-[12px] text-[color:var(--recorder-error)]">
        Day Recorder: {error}
      </p>
    ) : null;
  }

  const shownId = prompt.callId;
  const busy = busyFor === shownId;
  async function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusyFor(shownId);
    const r = await action();
    setBusyFor((current) => (current === shownId ? null : current));
    if (!r.ok) setError(r.error ?? "That didn't go through.");
  }

  const panel = "fade-in fixed bottom-5 left-5 z-[60] w-[340px] rounded-xl border bg-raised p-4 text-[13px]";
  const shadow = { boxShadow: "var(--shadow-lg)" };

  if (prompt.state !== "asking") {
    const text =
      prompt.state === "timedOut"
        ? "This call wasn't recorded: there was no answer before the time ran out."
        : "This call isn't being recorded: Geekspace couldn't save that you told everyone.";
    return (
      <div role="alert" className={`${panel} border-[color:var(--recorder-error)]`} style={shadow}>
        <h2 ref={heading} tabIndex={-1} className="pb-1 text-[13.5px] font-bold outline-none">
          Call not recorded
        </h2>
        <p className="pb-3 text-ink">{text}</p>
        {error && <p className="pb-2 text-[12px] text-[color:var(--recorder-error)]">{error}</p>}
        <button type="button" disabled={busy} onClick={() => void run(dismissCallWarning)} className={BUTTON}>
          Dismiss
        </button>
      </div>
    );
  }

  const callId = prompt.callId;
  return (
    <section aria-labelledby="call-prompt-title" className={`${panel} border-[#c27c0e]`} style={shadow}>
      <h2 id="call-prompt-title" ref={heading} tabIndex={-1} className="pb-1 text-[13.5px] font-bold outline-none">
        Call — not saved yet
      </h2>
      <p className="pb-2 text-ink">Tell everyone on this call it's being recorded and transcribed.</p>
      <p className="pb-3 text-[12px] text-ink">
        If you don't answer in <span className="font-semibold tabular-nums">{remainingLabel(prompt.deadline, now)}</span>, this call
        won't be recorded.
      </p>
      {error && (
        <p role="alert" className="pb-2 text-[12px] text-[color:var(--recorder-error)]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void run(() => answerCall("given", callId))} className={`${BUTTON} border-accent font-semibold`}>
          I told them — record
        </button>
        <button type="button" disabled={busy} onClick={() => void run(() => answerCall("declined", callId))} className={BUTTON}>
          Don't record this call
        </button>
        {prompt.canExtend && (
          <button type="button" disabled={busy} onClick={() => void run(() => answerCall("extend", callId))} className={BUTTON}>
            15 more minutes
          </button>
        )}
      </div>
    </section>
  );
}
