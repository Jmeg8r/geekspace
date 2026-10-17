import { useEffect, useState } from "react";
import { saveRecordingBeforeQuit } from "../../lib/meetingPipeline";
import { fallbackNav, useUI, type Nav } from "../../state/ui";
import { ViewLoading } from "./ViewLoading";

// Matches the main process's quit handshake (SAVE_ON_QUIT_TIMEOUT_MS in electron/main.mjs).
const SAVE_TIMEOUT_MS = 2 * 60 * 1000;

const BUTTON = "rounded-md border border-border px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hov hover:text-ink";

/**
 * Fallback for a main view that threw while rendering. A page that throws goes straight
 * Home (it may be a persisted id the backend rejects); other views explain and offer a way
 * out, so the sidebar and the rest of the window keep working.
 */
export function ViewError({ nav, error, reset }: { nav: Nav; error: Error; reset: () => void }) {
  const navigate = useUI((s) => s.navigate);
  const navRestored = useUI((s) => s.navRestored);
  const target = fallbackNav(nav, navRestored, "error");
  const leaving = target !== nav;

  useEffect(() => {
    if (leaving) navigate(target);
  }, [leaving, navigate, target]);

  if (leaving) return <ViewLoading />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-ink-3">
      <p className="text-[14px] text-ink-2">This view couldn't load.</p>
      <p className="max-w-md break-words text-[12px]">{error.message}</p>
      <div className="flex gap-2">
        <button type="button" className={BUTTON} onClick={reset}>
          Try again
        </button>
        {nav.kind !== "home" && (
          <button type="button" className={BUTTON} onClick={() => navigate({ kind: "home" })}>
            Go to Home
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Whole-app fallback, for an error outside any view (App itself runs queries). Both ways
 * out reload the renderer, which skips the main process's quit guard, so held meeting
 * audio (a live recording, or stopped audio not yet stored) is saved first. If that
 * fails, the screen stays and discarding takes an explicit click.
 */
export function AppCrash({
  error,
  reload = () => window.location.reload(),
  saveAudio = saveRecordingBeforeQuit,
  saveTimeoutMs = SAVE_TIMEOUT_MS,
}: {
  error: Error;
  reload?: () => void;
  saveAudio?: () => Promise<void>;
  saveTimeoutMs?: number;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const leave = async (beforeReload?: () => void) => {
    setSaving(true);
    // WHY bounded: with the backend down, the save's mutations wait for a reconnect and its
    // upload has no timeout, so an unbounded await would leave every button disabled. On
    // timeout the save keeps running; the user gets the controls back and decides.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`saving took too long (over ${Math.round(saveTimeoutMs / 1000)}s)`)),
        saveTimeoutMs
      );
    });
    try {
      await Promise.race([saveAudio(), timeout]);
    } catch (err) {
      console.error("Could not save the recording before reloading", err);
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
      return;
    } finally {
      clearTimeout(timer);
    }
    beforeReload?.();
    reload();
  };
  // The store persists synchronously, so the reload starts on Home.
  const goHome = () => useUI.getState().navigate({ kind: "home" });

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-ink-3">
      <p className="text-[15px] text-ink">Something went wrong.</p>
      <p className="max-w-md break-words text-[12px]">{error.message}</p>
      {saveError && (
        <p className="max-w-md break-words text-[12px] text-[var(--pal-red)]">
          Couldn't save the meeting recording before reloading: {saveError}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className={BUTTON} disabled={saving} onClick={() => void leave()}>
          Reload
        </button>
        <button type="button" className={BUTTON} disabled={saving} onClick={() => void leave(goHome)}>
          Go to Home
        </button>
        {saveError && (
          <button type="button" className={BUTTON} disabled={saving} onClick={reload}>
            Reload and discard the recording
          </button>
        )}
      </div>
    </div>
  );
}
