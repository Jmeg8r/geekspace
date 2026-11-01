import { useState } from "react";
import { statusCopy, type Tone } from "../../../electron/dayRecorderCopy.mjs";
import { dayRecorderAvailable, pauseRecorder, resumeRecorder } from "../../lib/dayRecorderBridge";
import { cn } from "../../lib/utils";
import { useRecorderStatus } from "./useRecorderStatus";

// WHAT: the Day Recorder's indicator in the app chrome (spec R1, plan PR 3e-2): a dot and the
// state in words, with one-click pause or resume. Shown only while the recorder is on.
// WHY words as well as the dot: state is never shown by colour alone (WCAG 1.4.1).

// Red and amber keep 3:1 against the light and dark sidebars (WCAG 1.4.11), as in the tray.
const DOT = {
  red: "bg-[#d93036]",
  amber: "bg-[#c27c0e]",
  grey: "bg-ink-2",
  hollow: "border-2 border-ink-2",
} satisfies Record<Tone, string>;

export function RecorderDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className={cn("h-2.5 w-2.5 shrink-0 rounded-full", DOT[tone])} />;
}

export function RecorderIndicator() {
  const { status, error: statusError } = useRecorderStatus();
  const [error, setError] = useState<string | null>(null);
  const copy = status ? statusCopy(status, { shortcut: true }) : null;
  // In the desktop app a failed status read is said, not hidden; a browser tab has no recorder.
  if (!copy && statusError && dayRecorderAvailable()) {
    return (
      <p role="alert" className="no-drag px-3 pb-2 text-[11.5px] text-[color:var(--recorder-error)]">
        Day Recorder: {statusError}
      </p>
    );
  }
  if (!copy) return null;

  const resume = copy.action === "resume";
  async function toggle() {
    const r = await (resume ? resumeRecorder() : pauseRecorder());
    setError(r.ok ? null : r.error);
  }

  return (
    <div className="no-drag px-2 pb-2">
      <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
        <RecorderDot tone={copy.tone} />
        <span role="status" aria-live="polite" title={copy.tooltip} className="min-w-0 flex-1 truncate text-[12px] font-semibold">
          {copy.title}
        </span>
        <button
          type="button"
          onClick={() => void toggle()}
          title={resume ? "Resume recording (⌥⌘R)" : "Pause recording (⌥⌘R)"}
          className="rounded px-1.5 py-0.5 text-[11.5px] text-ink hover:bg-hov focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {resume ? "Resume" : "Pause"}
          <span className="sr-only"> recording</span>
        </button>
      </div>
      {error && (
        <p role="alert" className="px-1 pt-1 text-[11.5px] text-[color:var(--recorder-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
