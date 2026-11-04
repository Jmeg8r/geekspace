// WHAT: the checks that must pass before the Day Recorder starts (spec F7, F8; plan PR 3c).
// - FileVault on: v1's encryption at rest for the raw media. Refuse to record without it.
// - Media root excluded from Time Machine: otherwise the 30-day purge never reaches backups.
// WHY fail closed: a check that can't run is treated as failed, never as passed.
// Output formats were read on the Mac Studio (macOS 27.0) and in spike Q9.
import { execFile } from "node:child_process";

const FDESETUP = "/usr/bin/fdesetup";
const TMUTIL = "/usr/bin/tmutil";
const CHECK_TIMEOUT_MS = 10_000;

/** Run a command and resolve with its stdout; injectable for tests. */
export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: CHECK_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]} failed: ${String(stderr).trim() || err.message}`));
      else resolve(String(stdout));
    });
  });
}

export async function checkFileVault(runCmd = run) {
  let out;
  try {
    out = await runCmd(FDESETUP, ["status"]);
  } catch (err) {
    return { ok: false, error: `Day Recorder couldn't check FileVault (${err?.message ?? err}), so it won't record.` };
  }
  // "FileVault is On." — anything else (Off, pending a restart, a new wording) refuses.
  if (/^FileVault is On\./m.test(out)) return { ok: true };
  return {
    ok: false,
    error:
      "Day Recorder needs FileVault, because recordings are stored on this Mac. " +
      "Turn it on in System Settings → Privacy & Security → FileVault, then try again.",
  };
}

export async function ensureBackupExclusion(root, runCmd = run) {
  try {
    // The sticky form (an xattr that travels with the folder). `-p` needs root (spike Q9).
    await runCmd(TMUTIL, ["addexclusion", root]);
    const out = await runCmd(TMUTIL, ["isexcluded", root]);
    if (/^\[Excluded\]/m.test(out)) return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Day Recorder couldn't keep its recordings out of Time Machine (${err?.message ?? err}), so it won't record.`,
    };
  }
  return {
    ok: false,
    error:
      "Day Recorder couldn't keep its recordings out of Time Machine: macOS still includes the folder. " +
      "Recordings deleted after 30 days would stay in backups, so it won't record.",
  };
}
