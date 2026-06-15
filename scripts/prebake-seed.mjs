// WHAT: Build-time step that produces build/convex-seed/ — a fresh Convex data
// dir with the app's functions deployed and the starter template seeded.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const BACKEND_VERSION = "precompiled-2026-06-09-b6aaa1a";
const BINARY = path.join(
  os.homedir(),
  ".cache/convex/binaries",
  BACKEND_VERSION,
  "convex-local-backend"
);
const CLOUD_PORT = 3210;
const SITE_PORT = 3211;
const URL = `http://127.0.0.1:${CLOUD_PORT}`;
const SRC_CONFIG = path.join(ROOT, ".convex", "local", "default", "config.json");
const OUT = path.join(ROOT, "build", "convex-seed");

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
    die(`backend binary missing at ${BINARY}\n  Run \`npm run dev\` once so the convex CLI downloads it.`);
  }
  if (!fs.existsSync(SRC_CONFIG)) {
    die(`no local deployment config at ${SRC_CONFIG}\n  Run \`npm run dev\` once to create the local deployment.`);
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

    console.log("• deploying functions (convex deploy)…");
    const dep = spawnSync(
      path.join(ROOT, "node_modules/.bin/convex"),
      ["deploy", "--env-file", SHENV, "--typecheck", "disable"],
      { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: 180000, killSignal: "SIGKILL" }
    );
    if (dep.status !== 0) {
      throw new Error(`convex deploy failed (status ${dep.status}${dep.signal ? ", " + dep.signal : ""})`);
    }

    console.log("• seeding starter template…");
    const res = await postJson("/api/mutation", {
      path: "seed:seedWorkspace",
      args: {},
      format: "json",
    });
    if (res.status !== "success") throw new Error(`seed failed: ${JSON.stringify(res)}`);

    const probe = await postJson("/api/query", { path: "pages:list", args: {}, format: "json" });
    const count = Array.isArray(probe.value) ? probe.value.length : 0;
    if (count < 1) throw new Error("seed produced no pages");
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
  }

  // --- capture the snapshot (only the files the runtime needs) ---
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(WORK, "config.json"), path.join(OUT, "config.json"));
  fs.copyFileSync(
    path.join(WORK, "convex_local_backend.sqlite3"),
    path.join(OUT, "convex_local_backend.sqlite3")
  );
  fs.cpSync(
    path.join(WORK, "convex_local_storage"),
    path.join(OUT, "convex_local_storage"),
    { recursive: true }
  );
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`• seed → ${path.relative(ROOT, OUT)}`);

  // --- copy the backend binary into build/ for electron-builder extraResources ---
  const OUT_BINARY = path.join(ROOT, "build", "convex-local-backend");
  fs.copyFileSync(BINARY, OUT_BINARY);
  fs.chmodSync(OUT_BINARY, 0o755);
  console.log(`• binary → ${path.relative(ROOT, OUT_BINARY)}`);

  // --- bundle the ARCHITECT MCP server into one self-contained file ---
  // WHY bundle: it's spawned as its own Node process. Shipping raw mcp/index.mjs
  // would need its node_modules + convex/_generated alongside it (bare ESM
  // imports don't resolve from a Resources/ path, and ESM-in-asar is unreliable).
  // esbuild inlines everything into one real file that runs from anywhere.
  const OUT_MCP = path.join(ROOT, "build", "geekspace-mcp.mjs");
  const esb = spawnSync(
    path.join(ROOT, "node_modules/.bin/esbuild"),
    ["mcp/index.mjs", "--bundle", "--platform=node", "--format=esm", `--outfile=${OUT_MCP}`],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] }
  );
  if (esb.status !== 0) throw new Error("esbuild bundle of mcp/index.mjs failed");
  console.log(`• mcp server → ${path.relative(ROOT, OUT_MCP)}`);

  console.log("✔ prebake complete → build/{convex-seed, convex-local-backend, geekspace-mcp.mjs}");
}

main().catch((err) => die(err?.stack ?? String(err)));
