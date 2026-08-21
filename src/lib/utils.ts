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

export const desktopPlatform = (): string | undefined =>
  (window as { geekspace?: { platform?: string } }).geekspace?.platform;

// WHY: browser dev (no preload bridge, so desktopPlatform() is undefined) has
// no platform string to read — sniff the UA so mac-styled shortcuts/copy
// still look right when QA'ing in a plain browser tab.
export function isMacLike(): boolean {
  const platform = desktopPlatform();
  if (platform !== undefined) return platform === "darwin";
  return /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
}

export const isWinDesktop = (): boolean => isElectron() && desktopPlatform() === "win32";

// WHY: module-level is fine — preload runs before renderer modules, so
// geekspace.platform is already set by the time this const evaluates.
export const MOD_LABEL = isMacLike() ? "⌘" : "Ctrl+";

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
