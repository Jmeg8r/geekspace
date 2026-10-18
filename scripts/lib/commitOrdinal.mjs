// WHAT: the build ordinal for a function bundle: the committer time (Unix seconds) of HEAD.
// WHY commit time, not build time: rebuilding yesterday's commit today must still read as
// yesterday's code, so an old branch or a rollback can't replace newer functions. Needs
// no full history, so it works in a shallow clone. See
// docs/changes/2026-10-17-function-sync-no-downgrade/.
import { spawnSync } from "node:child_process";

// Variables that point git at a repository other than the one at cwd. A git hook exports
// GIT_DIR (found by the pre-push hook, 2026-10-17), so a build run from one would read the
// hook's repository instead of the one it was asked about.
const REPO_LOCATING_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"];

/** Throws unless git reports a positive integer: a bundle must never ship without one. */
export function commitOrdinal(cwd) {
  const env = { ...process.env };
  for (const name of REPO_LOCATING_VARS) delete env[name];
  // No shell, so this runs the same on Windows (git.exe on PATH) and mac.
  const res = spawnSync("git", ["log", "-1", "--format=%ct"], { cwd, env, encoding: "utf8" });
  const text = res.stdout?.trim() ?? "";
  const ordinal = Number(text);
  if (res.status !== 0 || !/^\d+$/.test(text) || !Number.isInteger(ordinal) || ordinal <= 0) {
    const detail = res.error?.message ?? (res.stderr?.trim() || `output ${JSON.stringify(text)}`);
    throw new Error(`Couldn't read HEAD's commit time in ${cwd} (git exit ${res.status}): ${detail}`);
  }
  return ordinal;
}
