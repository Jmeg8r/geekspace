import { useEffect } from "react";
import { fallbackNav, useUI, type Nav } from "../../state/ui";
import { ViewLoading } from "./ViewLoading";

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

/** Whole-app fallback, for an error outside any view (App itself runs queries). */
export function AppCrash({ error }: { error: Error }) {
  const goHome = () => {
    // The store persists synchronously, so the reload starts on Home.
    useUI.getState().navigate({ kind: "home" });
    window.location.reload();
  };
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-ink-3">
      <p className="text-[15px] text-ink">Something went wrong.</p>
      <p className="max-w-md break-words text-[12px]">{error.message}</p>
      <div className="flex gap-2">
        <button type="button" className={BUTTON} onClick={() => window.location.reload()}>
          Reload
        </button>
        <button type="button" className={BUTTON} onClick={goHome}>
          Go to Home
        </button>
      </div>
    </div>
  );
}
