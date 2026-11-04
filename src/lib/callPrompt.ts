// WHAT: the call prompt's countdown (plan PR 4b). The notice deadline is shown, not hidden,
// so James can see how long he has and ask for more (spec, WCAG 2.2.1).

/**
 * The prompt once the first fetch answers: an event that came first (even null, a closed
 * prompt) is newer than the fetch, so it stands (Codex review of PR 4b, round 7).
 */
export function promptAfterFetch<P>(state: { heard: boolean; current: P | null }, fetched: P | null): P | null {
  return state.heard ? state.current : fetched;
}

/** "m:ss" left until `deadline`, never below zero. */
export function remainingLabel(deadline: number, now: number): string {
  const sec = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
