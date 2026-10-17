// WHAT: first-launch seeding of the per-user Convex data directory, whole or not at all.
// WHY: copying the seed straight into the live directory meant a quit or crash mid-copy
// left a partial database that every later launch accepted ("config.json exists").
// Staging next to the destination and renaming makes the copy atomic on one volume.
// Adapted from PR #28. See docs/changes/2026-10-16-electron-sync/.
import fs from "node:fs";
import path from "node:path";

const REQUIRED_FILES = ["config.json", "convex_local_backend.sqlite3"];

// cpSync preserves the relative layout the SQLite blob store relies on. Injectable so a
// copy that dies partway can be tested on every platform.
function defaultCopy(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

function assertComplete(directory) {
  for (const name of REQUIRED_FILES) {
    const file = path.join(directory, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      if (err.code === "ENOENT") throw new Error(`Seed is incomplete: ${name} is missing`);
      throw err;
    }
    if (!stat.isFile()) throw new Error(`Seed is invalid: ${name} is not a regular file`);
  }
}

/**
 * Seed `destination` from `seed` if it has no workspace yet. Returns true when it seeded.
 * A directory left without config.json by an older, non-atomic seeding is moved aside
 * (never deleted) and seeded fresh.
 */
export function seedDataDirectory(seed, destination, { copy = defaultCopy } = {}) {
  if (fs.existsSync(destination)) {
    if (fs.existsSync(path.join(destination, "config.json"))) return false;
    const aside = `${destination}.incomplete-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(destination, aside);
  }
  assertComplete(seed);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staged = fs.mkdtempSync(path.join(parent, ".geekspace-seed-"));
  try {
    copy(seed, staged);
    assertComplete(staged);
    fs.renameSync(staged, destination);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  return true;
}
