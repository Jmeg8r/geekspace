// WHAT: the build ordinal for a function bundle: the committer time (Unix seconds) of HEAD.
// WHY commit time, not build time: rebuilding yesterday's commit today must still read as
// yesterday's code, so an old branch or a rollback can't replace newer functions. Needs
// no full history, so it works in a shallow clone. See
// docs/changes/2026-10-17-function-sync-no-downgrade/.
import { spawnSync } from "node:child_process";

/** Throws unless git reports a positive integer: a bundle must never ship without one. */
export function commitOrdinal(cwd) {
  // No shell, so this runs the same on Windows (git.exe on PATH) and mac.
  const res = spawnSync("git", ["log", "-1", "--format=%ct"], { cwd, encoding: "utf8" });
  const text = res.stdout?.trim() ?? "";
  const ordinal = Number(text);
  if (res.status !== 0 || !/^\d+$/.test(text) || !Number.isInteger(ordinal) || ordinal <= 0) {
    const detail = res.error?.message ?? (res.stderr?.trim() || `output ${JSON.stringify(text)}`);
    throw new Error(`Couldn't read HEAD's commit time in ${cwd} (git exit ${res.status}): ${detail}`);
  }
  return ordinal;
}
