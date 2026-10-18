// WHAT: Build-time step that produces build/convex-seed/ — a fresh Convex data
// dir with the app's functions deployed and the starter template seeded — and
// build/convex-functions/, the deploy payload the packaged app replays into
// existing data dirs after an update (electron/functionSync.mjs).
// WHY: The packaged app ships this as the "factory" data so a first launch (or a
// reset) has a working, functions-loaded backend WITHOUT running the convex CLI
// or esbuild at runtime — esbuild's native subprocess can't read inside the asar
// archive, so deploying from the packaged app is fragile. We bake here, in the
// repo, where the full toolchain works natively.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backendAsset, backendCachePath, missingBinaryMessage } from "../electron/backendVersion.mjs";
import { verifiedFile } from "../electron/verifiedDownload.mjs";
import { MARKER_FILE, describeOrdinal, stripAdminKey, syncFunctions, writeBundle } from "../electron/functionSync.mjs";
import { commitOrdinal } from "./lib/commitOrdinal.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// WHY: Windows executables carry the .exe suffix; mirrors the same idiom in
// electron/convexBackend.mjs so both places name the binary identically.
const EXE = process.platform === "win32" ? ".exe" : "";

// The pinned backend (electron/backendVersion.mjs), where `npm run fetch-backend` puts it.
const BINARY = backendCachePath();
const CLOUD_PORT = 3210;
const SITE_PORT = 3211;
const URL = `http://127.0.0.1:${CLOUD_PORT}`;
const SRC_CONFIG = path.join(ROOT, ".convex", "local", "default", "config.json");
const OUT = path.join(ROOT, "build", "convex-seed");
const OUT_FUNCTIONS = path.join(ROOT, "build", "convex-functions");
// WHY: `.bin/convex` is a shim (a bash script on POSIX; a `.cmd`/`.ps1` pair on
// Windows) — unlaunchable directly and unsafe to invoke via a shell (see the
// spawnSync call below). The package's real JS entry works on both platforms.
const CONVEX_CLI = path.join(ROOT, "node_modules", "convex", "bin", "main.js");

function die(msg) {
  console.error(`✖ prebake: ${msg}`);
  process.exit(1);
}

async function isHealthy() {
  try {
    const r = await fetch(`${URL}/version`);
    return r.ok;
  } catch {
    return false;
  }
}

// POST helper with a hard timeout so a wedged backend can never hang the build.
async function postJson(endpoint, body, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${URL}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function waitHealthy(child, deadlineMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isHealthy()) return;
    if (child.exitCode !== null) die(`backend exited early (code ${child.exitCode})`);
    await new Promise((r) => setTimeout(r, 400));
  }
  die("backend did not become healthy in 30s");
}

async function main() {
  // --- preconditions ---
  if (!fs.existsSync(BINARY)) {
    die(missingBinaryMessage(BINARY));
  }
  const asset = backendAsset();
  if (!asset) die(`no pinned backend asset for ${process.platform}-${process.arch} in electron/backendVersion.mjs`);
  // WHY verify: this file is copied into the app bundle and run on every launch;
  // whatever sits at the cache path must be exactly the pinned release.
  if (!(await verifiedFile(BINARY, asset.binarySize, asset.binarySha256))) {
    die(`backend binary at ${BINARY} does not match the pinned size/SHA-256\n  Run \`npm run fetch-backend\` to replace it.`);
  }
  if (!fs.existsSync(SRC_CONFIG)) {
    die(`no local deployment config at ${SRC_CONFIG}\n  Run \`npm run dev\` once to create the local deployment.`);
  }
  if (!fs.existsSync(CONVEX_CLI)) {
    die(`convex CLI entry not found at ${CONVEX_CLI}\n  Run \`npm install\` first.`);
  }
  if (await isHealthy()) {
    die("something is already listening on :3210 — stop `npm run dev` before pre-baking.");
  }

  const cfg = JSON.parse(fs.readFileSync(SRC_CONFIG, "utf8"));
  if (!cfg.adminKey || !cfg.instanceSecret || !cfg.deploymentName) {
    die("source config.json is missing adminKey/instanceSecret/deploymentName");
  }

  // --- isolated work dir (never touch the dev .convex) ---
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "gs-prebake-"));
  // Reuse the existing deployment identity so the admin key stays valid and the
  // runtime config is uniform with a migrated workspace.
  fs.copyFileSync(SRC_CONFIG, path.join(WORK, "config.json"));
  const SHENV = path.join(WORK, "selfhosted.env");
  fs.writeFileSync(
    SHENV,
    `CONVEX_SELF_HOSTED_URL=${URL}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${cfg.adminKey}\n`
  );

  console.log(`• prebake work dir: ${WORK}`);
  // CRITICAL: redirect the backend's stdout/stderr to a file at the OS level
  // (not piped through Node). We run `convex deploy` via spawnSync below, which
  // BLOCKS the Node event loop — if the backend's output flowed through a JS
  // pipe, its 64KB pipe buffer would fill during the heavy push logging, the
  // backend would block on write, and deploy would deadlock waiting on it.
  const logFile = fs.openSync(path.join(WORK, "backend.log"), "a");
  const child = spawn(
    BINARY,
    [
      "--port", String(CLOUD_PORT),
      "--site-proxy-port", String(SITE_PORT),
      "--instance-name", cfg.deploymentName,
      "--instance-secret", cfg.instanceSecret,
      "--interface", "127.0.0.1",
      "--disable-beacon",
      "--local-storage", path.join(WORK, "convex_local_storage"),
      path.join(WORK, "convex_local_backend.sqlite3"),
    ],
    { cwd: WORK, stdio: ["ignore", logFile, logFile] }
  );

  try {
    console.log("• starting throwaway backend…");
    await waitHealthy(child);

    console.log("• building the deploy payload (convex deploy --write-push-request)…");
    // WHY write the payload instead of letting the CLI push: the packaged app replays this
    // exact payload into existing data dirs at startup (electron/functionSync.mjs), where
    // it can't run the CLI or esbuild. Pushing it here through the same module proves the
    // runtime path against the pinned backend on every build. Both flags are hidden in
    // convex 1.46.0's CLI; if a bump removes them, the file check below fails the build.
    // WHY process.execPath + CONVEX_CLI, not the `.bin/convex` shim: on
    // Windows that shim is a bash script (unlaunchable without a shell), and
    // its `.cmd` sibling throws EINVAL when spawned without `shell: true` on
    // patched Node (CVE-2024-27980). process.execPath is node here (this
    // script itself runs under node), so running the real entry point works
    // identically on both platforms.
    const pushRequestBase = path.join(WORK, "push-request");
    const dep = spawnSync(
      process.execPath,
      [
        CONVEX_CLI, "deploy", "--env-file", SHENV, "--typecheck", "disable",
        "--push-all-modules", "--write-push-request", pushRequestBase,
      ],
      { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: 180000, killSignal: "SIGKILL" }
    );
    // F6: on Windows, the convex CLI can finish its actual work successfully and THEN
    // crash during process teardown ("Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING), file src\win\async.c, line 76"), exiting nonzero regardless.
    // So the exit status is not the signal: the payload file existing and parsing is.
    // (The CLI also prints "Deployed" in this mode even though it pushes nothing.)
    let pushRequest;
    try {
      pushRequest = JSON.parse(fs.readFileSync(`${pushRequestBase}.json`, "utf8"));
    } catch (err) {
      throw new Error(
        `convex deploy did not write a readable push request (exit status ${dep.status}${dep.signal ? ", " + dep.signal : ""}): ${err?.message ?? err}`
      );
    }
    if (dep.status !== 0) {
      console.warn(
        `⚠ prebake: convex deploy exited with status ${dep.status} after writing the payload; ` +
          "matches the known Windows libuv-teardown crash, continuing."
      );
    }

    const convexVersion = JSON.parse(
      fs.readFileSync(path.join(ROOT, "node_modules", "convex", "package.json"), "utf8")
    ).version;
    // Throws without a readable HEAD: a bundle that can't say how new it is must not ship.
    const ordinal = commitOrdinal(ROOT);
    fs.rmSync(OUT_FUNCTIONS, { recursive: true, force: true });
    const hash = writeBundle(OUT_FUNCTIONS, stripAdminKey(pushRequest), { convexVersion, ordinal });
    console.log(
      `• functions bundle → ${path.relative(ROOT, OUT_FUNCTIONS)} (${hash.slice(0, 12)}, convex ${convexVersion}, code of ${describeOrdinal(ordinal)})`
    );

    console.log("• deploying the bundle through electron/functionSync.mjs…");
    const synced = await syncFunctions({
      dataDir: WORK,
      bundleDir: OUT_FUNCTIONS,
      url: URL,
      adminKey: cfg.adminKey,
      log: (line) => console.log(`  ${line}`),
      requireBundle: true,
    });
    if (synced.status !== "deployed") {
      throw new Error(`function sync did not deploy (status ${synced.status}): ${synced.error?.message ?? "no error"}`);
    }

    console.log("• seeding starter template…");
    const res = await postJson("/api/mutation", {
      path: "seed:seedWorkspace",
      args: {},
      format: "json",
    });
    if (res.status !== "success") {
      throw new Error(`seed failed: ${JSON.stringify(res)}`);
    }

    const probe = await postJson("/api/query", { path: "pages:list", args: {}, format: "json" });
    const count = Array.isArray(probe.value) ? probe.value.length : 0;
    if (count < 1) {
      throw new Error("seed produced no pages");
    }
    console.log(`• seeded ${count} top-level pages`);
  } finally {
    // Clean stop so SQLite checkpoints its WAL into the snapshot.
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolve();
      }, 5000);
      child.on("exit", () => { clearTimeout(t); resolve(); });
    });
    // WHY: NTFS refuses to rmSync a directory containing a file with an open
    // handle. The backend's log file (opened above) is still held until we
    // close it here, before the WORK dir is removed below.
    fs.closeSync(logFile);
  }

  // --- capture the snapshot (only the files the runtime needs) ---
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(WORK, "config.json"), path.join(OUT, "config.json"));
  // The marker syncFunctions wrote above: a fresh install starts out "current" and
  // doesn't redeploy what the seed already has.
  fs.copyFileSync(path.join(WORK, MARKER_FILE), path.join(OUT, MARKER_FILE));
  fs.copyFileSync(
    path.join(WORK, "convex_local_backend.sqlite3"),
    path.join(OUT, "convex_local_backend.sqlite3")
  );
  // WHY: on Windows the kill above is TerminateProcess (no SQLite checkpoint
  // on exit), so committed seed rows may still live in the WAL; shipping the
  // sidecars is correct — SQLite replays them on the packaged app's first
  // open. On mac, a clean SIGTERM checkpoints first, so these files don't
  // exist and the existsSync guards make this a no-op.
  for (const suffix of ["-wal", "-shm"]) {
    const src = path.join(WORK, `convex_local_backend.sqlite3${suffix}`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT, `convex_local_backend.sqlite3${suffix}`));
    }
  }
  fs.cpSync(
    path.join(WORK, "convex_local_storage"),
    path.join(OUT, "convex_local_storage"),
    { recursive: true }
  );
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch (err) {
    // WHY warn, not die: this is tmpdir cleanup, not a correctness issue — an
    // AV scanner can hold a transient lock on a file we just closed.
    console.warn(`⚠ prebake: could not remove work dir ${WORK}: ${err?.message ?? err}`);
  }
  console.log(`• seed → ${path.relative(ROOT, OUT)}`);

  // --- copy the backend binary into build/ for electron-builder extraResources ---
  const OUT_BINARY = path.join(ROOT, "build", "convex-local-backend" + EXE);
  fs.copyFileSync(BINARY, OUT_BINARY);
  fs.chmodSync(OUT_BINARY, 0o755); // no-op on Windows (no +x bit to set)
  console.log(`• binary → ${path.relative(ROOT, OUT_BINARY)}`);

  // --- bundle the ARCHITECT MCP server into one self-contained file ---
  // WHY bundle: it's spawned as its own Node process. Shipping raw mcp/index.mjs
  // would need its node_modules + convex/_generated alongside it (bare ESM
  // imports don't resolve from a Resources/ path, and ESM-in-asar is unreliable).
  // esbuild inlines everything into one real file that runs from anywhere.
  const OUT_MCP = path.join(ROOT, "build", "geekspace-mcp.mjs");
  // WHY the JS API, not a spawned `.bin/esbuild`: on macOS esbuild's
  // postinstall step replaces bin/esbuild with a native binary, while on
  // Windows the .bin entry is a shim script — no single spawn form is
  // portable across both. The JS API runs identically everywhere (esbuild is
  // already in node_modules as vite's dependency).
  const ESBUILD_PKG = path.join(ROOT, "node_modules", "esbuild");
  if (!fs.existsSync(ESBUILD_PKG)) {
    die(`esbuild not found at ${ESBUILD_PKG}\n  Run \`npm install\` first.`);
  }
  try {
    const esbuild = await import("esbuild");
    esbuild.buildSync({
      entryPoints: [path.join(ROOT, "mcp", "index.mjs")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: OUT_MCP,
      absWorkingDir: ROOT,
      logLevel: "warning",
    });
  } catch (err) {
    die(`esbuild bundle of mcp/index.mjs failed: ${err?.message ?? err}`);
  }
  console.log(`• mcp server → ${path.relative(ROOT, OUT_MCP)}`);

  console.log("✔ prebake complete → build/{convex-seed, convex-functions, convex-local-backend, geekspace-mcp.mjs}");
}

main().catch((err) => die(err?.stack ?? String(err)));
