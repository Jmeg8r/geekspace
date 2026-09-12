// Serialize writes so slow saves cannot overwrite a newer edit. Keep the latest
// unsaved value after a failure, for an explicit retry while the editor is open.
export function createSaveQueue(
  save: (value: string) => Promise<void>,
  report: (error: string | null) => void,
) {
  let pending: string | undefined;
  let active: Promise<void> | undefined;
  let failed = false;
  const flush = (): Promise<void> => {
    if (active) return active;
    failed = false;
    active = (async () => {
      while (pending !== undefined) {
        const value = pending;
        pending = undefined;
        try {
          await save(value);
          report(null);
        } catch (error) {
          if (pending === undefined) pending = value;
          failed = true;
          report(String(error));
          break;
        }
      }
    })().finally(() => {
      active = undefined;
      if (!failed && pending !== undefined) void flush();
    });
    return active;
  };
  return {
    enqueue(value: string) {
      pending = value;
      if (!failed) void flush();
    },
    flush,
    hasUnsaved: () => pending !== undefined || active !== undefined,
  };
}
