// WHAT: One-time copy of your existing dev Convex workspace into the standalone
// app's per-user data dir, so the packaged Geekspace opens with your real data.
// WHY: The dev backend stores data in the repo's .convex/local/default; the
// packaged app reads ~/Library/Application Support/Geekspace/convex. This bridges
// them once. Safe by default: it refuses to overwrite existing app data unless
// you pass --force.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, ".convex", "local", "default");
const DEST = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Geekspace",
  "convex"
);
const force = process.argv.includes("--force");

function die(msg) {
  console.error(`✖ migrate: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(SRC, "config.json"))) {
  die(`no dev workspace at ${SRC}\n  Run \`npm run dev\` (and \`npm run seed\`) at least once first.`);
}

if (fs.existsSync(path.join(DEST, "config.json")) && !force) {
  die(
    `app data already exists at:\n  ${DEST}\n` +
      `Refusing to overwrite. Re-run with --force to replace it (it will be backed up first)."`
  );
}

// If forcing over existing data, keep a timestamped backup — never destroy data.
if (fs.existsSync(DEST)) {
  const backup = `${DEST}.bak`;
  fs.rmSync(backup, { recursive: true, force: true });
  fs.renameSync(DEST, backup);
  console.log(`• existing app data moved aside → ${backup}`);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });

const sqlite = path.join(DEST, "convex_local_backend.sqlite3");
const sizeMb = (fs.statSync(sqlite).size / 1e6).toFixed(1);
console.log(`✔ migrated your workspace → ${DEST}`);
console.log(`  (${sizeMb} MB SQLite + file storage). Launch Geekspace to use it.`);
