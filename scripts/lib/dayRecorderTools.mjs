// WHAT: the decisions behind the PR 3c part 2 tools: what `day-recorder-ctl.mjs` may print,
// and how `soak-rss.mjs` judges a soak. Pure functions, so tests/dayRecorderTools.test.ts can
// check them without a backend or a two-hour run.
// WHY: the ctl script's output lands in terminals and evidence logs, where a denylisted app
// must never be named (protocol.md). A soak verdict must not pass when the helper wasn't
// running for the run (Codex review of #80, final check).

/** The settings fields safe to print: the denylist becomes a count. */
export function safeSettings(s) {
  return {
    enabled: s.enabled,
    denylistCount: s.denylist.length,
    shotSec: s.shotSec,
    batchMin: s.batchMin,
    dailyCapSet: s.dailyCapUsd !== null,
  };
}

/**
 * A ctl failure as printable text. A backend error's message can echo the arguments, the
 * denylist included, so only its name is kept.
 */
export function describeCtlError(err, convexUrl) {
  const message = String(err?.message ?? err);
  if (/fetch failed|ECONNREFUSED/.test(message)) {
    return `no Geekspace backend at ${convexUrl}. Open Geekspace first (it starts the backend).`;
  }
  return `the backend refused the request (${err?.name ?? "Error"}); details withheld because they can name denylisted apps`;
}

/**
 * Judge a soak (spec R2). Each role must grow less than `limitMB` from the first sample at or
 * after the warmup mark, and the helper must be present in every sample with a single pid.
 */
export function judgeSoak(rows, { warmupMinutes, limitMB }) {
  const failures = [];
  const missing = rows.filter((r) => r.helperPids.length === 0).length;
  if (missing > 0) failures.push(`gs-capture missing in ${missing} of ${rows.length} samples`);
  const pids = new Set(rows.flatMap((r) => r.helperPids));
  if (pids.size > 1) failures.push(`gs-capture restarted (${pids.size} pids)`);

  const base = rows.find((r) => r.elapsedMin >= warmupMinutes);
  const growth = {};
  if (!base || base.byRole.helper === undefined) {
    failures.push("no baseline at the warmup mark: gs-capture was not running then");
  } else {
    const after = rows.filter((r) => r.elapsedMin >= base.elapsedMin);
    for (const [role, atWarmup] of Object.entries(base.byRole)) {
      const peak = Math.max(...after.map((r) => r.byRole[role] ?? 0));
      const grew = +(peak - atWarmup).toFixed(1);
      growth[role] = { atWarmupMB: +atWarmup.toFixed(1), peakMB: +peak.toFixed(1), growthMB: grew };
      if (grew >= limitMB) failures.push(`${role} grew ${grew} MB`);
    }
  }
  return { pass: failures.length === 0, failures, growth, helperPids: [...pids] };
}

/**
 * An error in the ctl script's own input (usage, a flag, a marker label). Its message is the
 * script's own wording, so it is safe to print. WHY a class: whether an error is ours is
 * decided by type, never by its text, because a backend message can look like ours (Codex
 * re-check of #80).
 */
export class CtlUsageError extends Error {
  name = "CtlUsageError";
}

/**
 * When a soak takes its samples, in ms from the start: every `intervalMs`, plus one at
 * `totalMs` itself. WHY the last one: a helper that dies after the final interval sample must
 * still fail the run (Codex re-check of #80).
 */
export function soakSchedule(totalMs, intervalMs) {
  const times = [];
  for (let t = 0; t < totalMs; t += intervalMs) times.push(t);
  times.push(totalMs);
  return times;
}

const BUNDLED_HELPER = "Geekspace.app/Contents/Resources/gs-capture";

/**
 * Which part of the app a process is, from its executable path, or null for anything else.
 * WHY only the bundled helper counts: a stray `gs-capture` run (a dev build, a diagnostic
 * subcommand) must not stand in for the recorder's own helper in a soak verdict (Codex
 * re-check round 3 of #80).
 */
export function processRole(comm) {
  if (comm.endsWith(BUNDLED_HELPER)) return "helper";
  if (!comm.includes("Geekspace.app/")) return null;
  if (comm.endsWith("Contents/MacOS/Geekspace")) return "main";
  if (comm.includes("(Renderer)")) return "renderer";
  if (comm.includes("(GPU)")) return "gpu";
  if (comm.includes("convex-local-backend")) return "backend";
  return "otherHelper";
}
