// WHAT: types for the shell's trust rules, so tests/ can import them (see meetingProcessor.d.mts).

export function isAppUrl(url: string, opts: { devServerUrl?: string; indexFile?: string }): boolean;
export function isSafeExternalUrl(url: string): boolean;
export function isLocalStorageUrl(url: string, port: number): boolean;
