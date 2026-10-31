// WHAT: types for the PR 3c part 2 tool decisions, so tests/ can import them.

export type RecorderSettingsView = {
  enabled: boolean;
  paused: boolean;
  denylist: string[];
  shotSec: number;
  batchMin: number;
  dailyCapUsd: number | null;
};

export function safeSettings(s: RecorderSettingsView): {
  enabled: boolean;
  paused: boolean;
  denylistCount: number;
  shotSec: number;
  batchMin: number;
  dailyCapSet: boolean;
};

export function describeCtlError(err: unknown, convexUrl: string): string;

/** One soak sample: resident MB per process role, plus media-file counts. */
export type SoakRow = {
  elapsedMin: number;
  byRole: Record<string, number>;
  helperPids: number[];
  shots: number;
  segments: number;
  partials: number;
};

export function judgeSoak(
  rows: SoakRow[],
  options: { warmupMinutes: number; limitMB: number }
): {
  pass: boolean;
  failures: string[];
  growth: Record<string, { atWarmupMB: number; peakMB: number; growthMB: number }>;
  helperPids: number[];
};

export class CtlUsageError extends Error {}

export function soakSchedule(totalMs: number, intervalMs: number): number[];

export function processRole(comm: string): "helper" | "main" | "renderer" | "gpu" | "backend" | "otherHelper" | null;
