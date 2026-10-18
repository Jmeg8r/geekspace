import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitOrdinal } from "../scripts/lib/commitOrdinal.mjs";

// WHAT: the build ordinal is the committer time of HEAD, and a build without one stops.
// See docs/changes/2026-10-17-function-sync-no-downgrade/.

const ROOT = path.join(__dirname, "..");

describe("commitOrdinal", () => {
  it("is HEAD's committer time in Unix seconds", () => {
    const expected = Number(spawnSync("git", ["log", "-1", "--format=%ct"], { cwd: ROOT, encoding: "utf8" }).stdout.trim());
    expect(Number.isInteger(expected)).toBe(true);
    expect(commitOrdinal(ROOT)).toBe(expected);
  });

  it("reads the repository at cwd even when git's environment names another (as in a git hook)", () => {
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ordinal-"));
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = gitDir;
    try {
      expect(() => commitOrdinal(dir)).toThrow(/commit time/i);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws outside a git repository", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-ordinal-"));
    try {
      expect(() => commitOrdinal(dir)).toThrow(/commit time/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
