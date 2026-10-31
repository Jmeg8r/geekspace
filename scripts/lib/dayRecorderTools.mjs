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
