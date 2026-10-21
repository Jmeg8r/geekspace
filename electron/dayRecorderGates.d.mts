// WHAT: types for the Day Recorder start gates, so tests/ can import it.

export type Run = (cmd: string, args: string[]) => Promise<string>;
export type GateResult = { ok: true } | { ok: false; error: string };

export const run: Run;
export function checkFileVault(run?: Run): Promise<GateResult>;
export function ensureBackupExclusion(root: string, run?: Run): Promise<GateResult>;
