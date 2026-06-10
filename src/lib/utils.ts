export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  flush(): void;
  cancel(): void;
}

// WHY: flush() lets callers persist pending edits on unmount so fast navigation
// never loses keystrokes.
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const run = () => {
    timer = null;
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };
  const debounced = ((...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Debounced<A>;
  debounced.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return debounced;
}

/** Current tz offset in minutes behind UTC — threaded into scheduling mutations. */
export const tzOffsetMin = () => new Date().getTimezoneOffset();

export const isElectron = (): boolean =>
  Boolean((window as { geekspace?: { isElectron?: boolean } }).geekspace?.isElectron);

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
