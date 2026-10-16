import { useEffect, useState } from "react";
import { nextDay } from "./dates";

// WHAT: the local midnight that starts today, kept current.
// WHY: Home memoised it once, so a window left open overnight kept showing yesterday's
// agenda. It now advances at midnight, and on focus or wake (a sleeping laptop misses the
// timer). See docs/changes/2026-10-15-scheduler-dst-perf/.

function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function useDayStart(): number {
  const [dayStart, setDayStart] = useState(todayStart);
  useEffect(() => {
    const refresh = () => setDayStart(todayStart());
    const timer = setTimeout(refresh, nextDay(dayStart) - Date.now() + 1000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [dayStart]);
  return dayStart;
}
