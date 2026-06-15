// WHAT: Push the current convex/ functions to your RUNNING standalone Geekspace
// backend (the one the .app started on :3210).
// WHY: App updates never clobber your per-user data, so after you change backend
// functions and rebuild, your live data dir still runs the old code. Run this
// once (with Geekspace open) to deploy the new functions onto it. The admin key
// is read from the local config at runtime — never committed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const URL = "http://127.0.0.1:3210";

// Prefer the running app's data dir; fall back to the repo's dev config. Both
// share the same instance identity, so the admin key is valid either way.
const CANDIDATES = [
  path.join(os.homedir(), "Library", "Application Support", "Geekspace", "convex", "config.json"),
  path.join(ROOT, ".convex", "local", "default", "config.json"),
];
const cfgPath = CANDIDATES.find((p) => fs.existsSync(p));
if (!cfgPath) {
  console.error("✖ deploy:local: no Convex config.json found (run the app or `npm run dev` once).");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const envFile = path.join(os.tmpdir(), `gs-deploy-${process.pid}.env`);
fs.writeFileSync(
  envFile,
  `CONVEX_SELF_HOSTED_URL=${URL}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${cfg.adminKey}\n`
);

try {
  console.log(`• deploying convex/ functions to ${URL} (open Geekspace must be running)…`);
  const res = spawnSync(
    path.join(ROOT, "node_modules/.bin/convex"),
    ["deploy", "--env-file", envFile, "--typecheck", "disable"],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: 180000, killSignal: "SIGKILL" }
  );
  process.exitCode = res.status ?? 1;
} finally {
  fs.rmSync(envFile, { force: true });
}
