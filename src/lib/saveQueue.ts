// WHAT: serialises document saves. Only the newest pending value is sent, one save at a
// time, so a slow older save can never land after a newer one. After a failure the
// newest unsaved value is kept until a later save or an explicit retry succeeds.
// Ported from PR #28. See docs/changes/2026-10-15-editor-saves/.
export function createSaveQueue(
  save: (value: string) => Promise<void>,
  report: (error: string | null) => void
) {
  let pending: string | undefined;
  let active: Promise<void> | undefined;
  let failed = false;
  // While held (a conflict is open), nothing is sent, not even by an explicit flush.
  let held = false;

  const flush = (): Promise<void> => {
    if (active) return active;
    if (held) return Promise.resolve();
    failed = false;
    active = (async () => {
      while (pending !== undefined && !held) {
        const value = pending;
        pending = undefined;
        try {
          await save(value);
          report(null);
        } catch (error) {
          // Keep this value unless a newer edit arrived while it was in flight.
          if (pending === undefined) pending = value;
          failed = true;
          report(String(error));
          break;
        }
      }
    })().finally(() => {
      active = undefined;
      if (!failed && !held && pending !== undefined) void flush();
    });
    return active;
  };

  return {
    enqueue(value: string) {
      pending = value;
      // After a failure, wait for an explicit retry (flush) instead of hammering a
      // backend that just rejected us; the newest value is held meanwhile.
      if (!failed && !held) void flush();
    },
    flush,
    hold() {
      held = true;
    },
    release() {
      held = false;
    },
    /** Forget a value that is waiting to be sent (not one already in flight). */
    discardPending() {
      pending = undefined;
    },
    hasUnsaved: () => pending !== undefined || active !== undefined,
  };
}
