import { useEffect, useState } from "react";
import { onRecorderStatus, recorderStatus, type RecorderStatus } from "../../lib/dayRecorderBridge";

// WHAT: the Day Recorder's status as the main process's status view reports it (3e-1), so
// the app never shows the passing `off` either. `error` says why there is no status at all.
export type RecorderStatusState = { status: RecorderStatus | null; error: string | null };

export function useRecorderStatus(): RecorderStatusState {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const off = onRecorderStatus((s) => {
      setStatus(s);
      setError(null);
    });
    void recorderStatus().then((r) => {
      if (!live) return;
      // An event that arrived first is newer than this answer.
      if (r.ok) setStatus((current) => current ?? r.data);
      else setError(r.error);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  return { status, error };
}
