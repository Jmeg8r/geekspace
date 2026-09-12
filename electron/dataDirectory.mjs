// Filesystem-only primitives shared by first launch and explicit migration.
// Callers must stop source/destination backends before copying SQLite + WAL.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function validateDataDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Data directory must be a regular directory");
  for (const name of ["config.json", "convex_local_backend.sqlite3"]) {
    const entry = fs.lstatSync(path.join(directory, name));
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error(`Invalid data file: ${name}`);
  }
  const config = JSON.parse(
    fs.readFileSync(path.join(directory, "config.json"), "utf8"),
  );
  if (
    ![config.deploymentName, config.instanceSecret, config.adminKey].every(
      (v) => typeof v === "string" && v.length > 0,
    )
  ) {
    throw new Error(
      "Incomplete data config; preserve the directory and restore its config before retrying",
    );
  }
}

export function copyDataDirectory(
  source,
  destination,
  { replace = false } = {},
) {
  validateDataDirectory(source);
  if (fs.existsSync(destination) && !replace)
    throw new Error(`Existing data at ${destination}; refusing to overwrite`);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staged = fs.mkdtempSync(path.join(parent, ".geekspace-copy-"));
  let backup;
  try {
    fs.cpSync(source, staged, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    validateDataDirectory(staged);
    if (fs.existsSync(destination)) {
      if (!replace)
        throw new Error(
          "Data appeared during initialization; refusing to overwrite",
        );
      const stat = fs.lstatSync(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Destination must be a regular directory");
      backup = `${destination}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      fs.renameSync(destination, backup);
    }
    try {
      fs.renameSync(staged, destination);
    } catch (error) {
      if (backup && !fs.existsSync(destination))
        fs.renameSync(backup, destination);
      throw error;
    }
    return backup;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

export function ensureDataDirectory(destination, seed) {
  if (fs.existsSync(destination)) {
    validateDataDirectory(destination);
    return false;
  }
  const parent = path.dirname(destination);
  if (
    fs.existsSync(parent) &&
    fs
      .readdirSync(parent)
      .some((name) => name.startsWith(`${path.basename(destination)}.bak-`))
  ) {
    throw new Error(
      "A previous workspace backup exists; restore it before initializing a new workspace",
    );
  }
  copyDataDirectory(seed, destination);
  return true;
}
