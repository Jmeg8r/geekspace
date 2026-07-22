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
import { packagedConvexDir } from "./lib/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const URL = "http://127.0.0.1:3210";
// WHY: `.bin/convex` is a shim (a bash script on POSIX; a `.cmd`/`.ps1` pair on
// Windows) — unlaunchable directly and unsafe to invoke via a shell (see the
// spawnSync call below). The package's real JS entry works on both platforms.
const CONVEX_CLI = path.join(ROOT, "node_modules", "convex", "bin", "main.js");

// Prefer the running app's data dir; fall back to the repo's dev config. All
// share the same instance identity, so the admin key is valid either way.
const CANDIDATES = [
  path.join(packagedConvexDir(), "config.json"),
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
  // WHY process.execPath + CONVEX_CLI, not the `.bin/convex` shim: see the
  // CONVEX_CLI comment above. process.execPath is node here (this script
  // itself runs under node), so running the real entry point works
  // identically on both platforms.
  const res = spawnSync(
    process.execPath,
    [CONVEX_CLI, "deploy", "--env-file", envFile, "--typecheck", "disable"],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: 180000, killSignal: "SIGKILL" }
  );
  if (res.status !== 0) {
    // F6: on Windows, the convex CLI can finish `deploy`'s actual work
    // successfully and THEN crash during process teardown, exiting nonzero
    // regardless — a false-negative exit code. Unlike prebake, this is an
    // interactive helper with no seed/probe to verify against, so we still
    // exit nonzero — but check the running app before assuming it failed.
    console.warn(
      `⚠ deploy:local: convex deploy exited with status ${res.status}. On Windows this can happen ` +
        "AFTER a successful deploy (a libuv-teardown crash) — check the running Geekspace app to confirm before retrying."
    );
  }
  process.exitCode = res.status ?? 1;
} finally {
  fs.rmSync(envFile, { force: true });
}
