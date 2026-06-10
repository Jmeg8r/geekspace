import { useState, useSyncExternalStore } from "react";
import { Mic, Pause, Play, Square, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { recorder } from "../../lib/recorder";
import { cancelRecording, finishRecording } from "../../lib/meetingPipeline";
import { useUI } from "../../state/ui";

// WHAT: Floating recording HUD — pinned bottom-right, survives navigation.
export function RecorderWidget() {
  const state = useSyncExternalStore(recorder.subscribe, recorder.getState);
  const navigate = useUI((s) => s.navigate);
  const [stopping, setStopping] = useState(false);

  if (state.status === "idle") return null;

  const mm = String(Math.floor(state.elapsedSec / 60)).padStart(2, "0");
  const ss = String(state.elapsedSec % 60).padStart(2, "0");
  const bars = [0.15, 0.35, 0.55, 0.75, 0.92];

  async function stop() {
    setStopping(true);
    try {
      navigate({ kind: "meetings" });
      await finishRecording();
    } finally {
      setStopping(false);
    }
  }

  return (
    <div
      className="fade-in fixed bottom-5 right-5 z-[55] flex items-center gap-3 rounded-xl border border-border bg-raised px-3.5 py-2.5"
      style={{ boxShadow: "var(--shadow-lg)" }}
    >
      <span
        className={cn(
          "h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--pal-red)]",
          state.status === "recording" && "animate-pulse"
        )}
      />
      <div className="min-w-0">
        <div className="max-w-44 truncate text-[12.5px] font-semibold leading-tight">
          {state.title || "Recording"}
        </div>
        <div className="text-[11.5px] tabular-nums text-ink-3">
          {state.status === "paused" ? "Paused · " : ""}
          {mm}:{ss}
        </div>
      </div>

      {/* live level meter */}
      <div className="flex h-6 items-end gap-0.5">
        {bars.map((threshold, i) => (
          <span
            key={i}
            className={cn("w-1 rounded-sm transition-all duration-100")}
            style={{
              height: `${30 + i * 17}%`,
              background:
                state.status === "recording" && state.level >= threshold * 0.55
                  ? "var(--accent)"
                  : "var(--border-c)",
            }}
          />
        ))}
      </div>

      {state.status === "recording" ? (
        <button title="Pause" onClick={() => recorder.pause()} className="rounded-md p-1.5 text-ink-2 hover:bg-hov hover:text-ink">
          <Pause size={15} />
        </button>
      ) : (
        <button title="Resume" onClick={() => recorder.resume()} className="rounded-md p-1.5 text-ink-2 hover:bg-hov hover:text-ink">
          <Play size={15} />
        </button>
      )}
      <button
        title="Stop & generate notes"
        disabled={stopping}
        onClick={() => void stop()}
        className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-accent-2 disabled:opacity-60"
      >
        <Square size={12} fill="currentColor" /> Stop
      </button>
      <button
        title="Discard recording"
        onClick={() => {
          if (confirm("Discard this recording?")) void cancelRecording();
        }}
        className="rounded-md p-1 text-ink-3 hover:bg-hov hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function SidebarRecordingDot() {
  const status = useSyncExternalStore(recorder.subscribe, () => recorder.getState().status);
  if (status === "idle") return null;
  return <span className="ml-1 h-2 w-2 animate-pulse rounded-full bg-[var(--pal-red)]" />;
}

export const MicIcon = Mic;
