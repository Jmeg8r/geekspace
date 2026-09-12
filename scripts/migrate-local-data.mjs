import { copyDataDirectory } from "../electron/dataDirectory.mjs";
import net from "node:net";
// WHAT: One-time copy of your existing dev Convex workspace into the standalone
// app's per-user data dir, so the packaged Geekspace opens with your real data.
// WHY: The dev backend stores data in the repo's .convex/local/default; the
// packaged app reads ~/Library/Application Support/Geekspace/convex. This bridges
// them once. Safe by default: it refuses to overwrite existing app data unless
// you pass --force.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packagedConvexDir } from "./lib/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, ".convex", "local", "default");
const DEST = packagedConvexDir();
const force = process.argv.includes("--force");

function die(msg) {
  console.error(`✖ migrate: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(SRC, "config.json"))) {
  die(
    `no dev workspace at ${SRC}\n  Run \`npm run dev\` (and \`npm run seed\`) at least once first.`,
  );
}

if (fs.existsSync(DEST) && !force) {
  die(
    `app data already exists at:\n  ${DEST}\n` +
      `Refusing to overwrite. Re-run with --force to replace it (it will be backed up first)."`,
  );
}

// Refuse a copy while the standard local backend is running: SQLite and its
// WAL must be copied together while idle on both macOS and Windows.
const listening = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: "127.0.0.1", port: 3210 });
  socket.setTimeout(1500);
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", (error) => {
    socket.destroy();
    if (error.code === "ECONNREFUSED") resolve(false);
    else reject(error);
  });
  socket.once("timeout", () => {
    socket.destroy();
    reject(new Error("Cannot determine whether the backend is stopped"));
  });
});
if (listening) die("Stop Geekspace and convex dev before migrating data.");
const backup = copyDataDirectory(SRC, DEST, { replace: force });
if (backup) console.log(`• existing data preserved at ${backup}`);

const sqlite = path.join(DEST, "convex_local_backend.sqlite3");
const sizeMb = (fs.statSync(sqlite).size / 1e6).toFixed(1);
console.log(`✔ migrated your workspace → ${DEST}`);
console.log(
  `  (${sizeMb} MB SQLite + file storage). Launch Geekspace to use it.`,
);
