import { describe, expect, it } from "vitest";
import { checkFileVault, ensureBackupExclusion, type Run } from "../electron/dayRecorderGates.mjs";

// WHAT: the two checks that must pass before the Day Recorder starts (spec F7, F8; plan PR 3c).
// FileVault is v1's encryption at rest, so recording refuses to start without it. The media
// root is excluded from Time Machine, so the 30-day purge also reaches backups.
// Output formats were read on the Mac Studio (macOS 27.0) and in spike Q9.

const ROOT = "/Users/someone/Library/Application Support/Geekspace/day-recorder";

/** A fake command runner: answers by "<cmd> <args>" and records every call. */
function runner(answers: Record<string, { stdout?: string; error?: string }>) {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected command ${key}`);
    if (answer.error) throw new Error(answer.error);
    return answer.stdout ?? "";
  };
  return { run, calls };
}

describe("checkFileVault", () => {
  it("passes when FileVault is on", async () => {
    const { run } = runner({ "/usr/bin/fdesetup status": { stdout: "FileVault is On.\n" } });
    expect(await checkFileVault(run)).toEqual({ ok: true });
  });

  it.each([
    ["off", "FileVault is Off.\n"],
    ["still encrypting", "FileVault is Off, but will be enabled after the next restart.\n"],
    ["unrecognised", "something new\n"],
  ])("refuses when FileVault is %s, saying how to fix it", async (_name, stdout) => {
    const { run } = runner({ "/usr/bin/fdesetup status": { stdout } });
    const result = await checkFileVault(run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/System Settings → Privacy & Security → FileVault/);
  });

  it("refuses, not passes, when the check itself fails", async () => {
    const { run } = runner({ "/usr/bin/fdesetup status": { error: "spawn EACCES" } });
    const result = await checkFileVault(run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/couldn't check FileVault.*spawn EACCES/);
  });
});

describe("ensureBackupExclusion", () => {
  it("adds the sticky exclusion and confirms it", async () => {
    const { run, calls } = runner({
      [`/usr/bin/tmutil addexclusion ${ROOT}`]: {},
      [`/usr/bin/tmutil isexcluded ${ROOT}`]: { stdout: `[Excluded]  ${ROOT}\n` },
    });
    expect(await ensureBackupExclusion(ROOT, run)).toEqual({ ok: true });
    // Never the -p fixed-path form: it needs root (spike Q9).
    expect(calls.some((c) => c.includes(" -p "))).toBe(false);
  });

  it("refuses when the folder is still included after adding the exclusion", async () => {
    const { run } = runner({
      [`/usr/bin/tmutil addexclusion ${ROOT}`]: {},
      [`/usr/bin/tmutil isexcluded ${ROOT}`]: { stdout: `[Included]  ${ROOT}\n` },
    });
    const result = await ensureBackupExclusion(ROOT, run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Time Machine/);
  });

  it("refuses when tmutil fails", async () => {
    const { run } = runner({ [`/usr/bin/tmutil addexclusion ${ROOT}`]: { error: "exit 80" } });
    const result = await ensureBackupExclusion(ROOT, run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exit 80/);
  });
});
