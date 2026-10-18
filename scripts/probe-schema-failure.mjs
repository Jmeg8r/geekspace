// WHAT: Integration probe: replays a deploy payload whose schema rejects existing data into
// a throwaway Convex backend, and checks electron/functionSync.mjs stops before finish_push,
// keeps the old marker, and leaves the old functions serving.
// WHY: tests/functionSync.test.ts proves this against a fake backend only; this proves the
// real pinned backend reports the failure the way functionSync expects. It is a script, not
// a vitest suite, because CI has no backend binary and a suite that skipped there would
// still show green (docs/changes/2026-10-17-schema-failure-probe/plan.md).
// Never touches :3210 or a real data dir: ports 3290/3291 and a temp dir, removed on exit.
// If the script is killed hard, a backend may outlive it: `lsof -iTCP:3290 -sTCP:LISTEN`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backendAsset, backendCachePath, missingBinaryMessage } from "../electron/backendVersion.mjs";
import { verifiedFile } from "../electron/verifiedDownload.mjs";
import { readMarker, stripAdminKey, syncFunctions, writeBundle } from "../electron/functionSync.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD_PORT = 3290;
const SITE_PORT = 3291;
const URL = `http://127.0.0.1:${CLOUD_PORT}`;
const CONVEX_CLI = path.join(ROOT, "node_modules", "convex", "bin", "main.js");
const DEFAULT_CONFIG = path.join(ROOT, ".convex", "local", "default", "config.json");
const HEALTH_DEADLINE_MS = 30_000;
const HEALTH_POLL_MS = 400;
const REQUEST_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 5_000;
const LOG_TAIL_LINES = 40;
const HASH_PREFIX_CHARS = 12;
// The table the narrowed schema rejects, and the edit that narrows it: a required field
// no seeded page has. The anchor is the pages table's first field.
const REJECTING_TABLE = "pages";
const SCHEMA_ANCHOR = "  pages: defineTable({\n    title: v.string(),\n";
const SCHEMA_NARROWED = `${SCHEMA_ANCHOR}    probeRequired: v.string(),\n`;
// What the temp project needs besides its own copy of convex/ for the CLI to bundle it.
const PROJECT_LINKS = ["package.json", "tsconfig.json", "node_modules"];

// Values that must never reach the terminal, filled once the config is read.
const secrets = [];
const redact = (text) => secrets.reduce((out, s) => out.split(s).join("[redacted]"), String(text));

function configPath() {
  const i = process.argv.indexOf("--config");
  if (i === -1) return DEFAULT_CONFIG;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error("--config needs a path to a convex config.json");
  return path.resolve(value);
}

async function isListening() {
  try {
    await fetch(`${URL}/version`, { signal: AbortSignal.timeout(HEALTH_POLL_MS * 5) });
    return true;
  } catch {
    // Connection refused (or no answer): nothing usable is on the port.
    return false;
  }
}

async function waitHealthy(child, spawnError) {
  const start = Date.now();
  while (Date.now() - start < HEALTH_DEADLINE_MS) {
    // Rethrown as a plain message: the original carries spawnargs, which hold the instance secret.
    if (spawnError()) throw new Error(`backend failed to start: ${spawnError().code ?? spawnError().message}`);
    if (child.exitCode !== null) throw new Error(`backend exited early (code ${child.exitCode})`);
    if (await isListening()) return;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`backend did not become healthy in ${HEALTH_DEADLINE_MS / 1000}s`);
}

async function callFunction(kind, functionPath) {
  const res = await fetch(`${URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: functionPath, args: {}, format: "json" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json();
  if (body.status !== "success") throw new Error(`${functionPath} failed: ${JSON.stringify(body).slice(0, 500)}`);
  return body.value;
}

/** Run the CLI in payload-only mode from projectDir and bundle the result into bundleDir. */
function buildBundle({ projectDir, envFile, workDir, bundleDir, label }) {
  const base = path.join(workDir, `push-request-${label}`);
  const cli = spawnSync(
    process.execPath,
    [CONVEX_CLI, "deploy", "--env-file", envFile, "--typecheck", "disable", "--push-all-modules", "--write-push-request", base],
    { cwd: projectDir, encoding: "utf8", timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" }
  );
  let request;
  try {
    request = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
  } catch (err) {
    const output = `${cli.stdout ?? ""}${cli.stderr ?? ""}`.trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
    throw new Error(`convex deploy (${label}) wrote no readable payload (exit ${cli.status}): ${err.message}\n${output}`);
  }
  return writeBundle(bundleDir, stripAdminKey(request), { convexVersion: "probe" });
}

/** A copy of the project whose schema adds a required field to REJECTING_TABLE. */
function narrowedProject(workDir) {
  const dir = path.join(workDir, "narrowed-project");
  fs.cpSync(path.join(ROOT, "convex"), path.join(dir, "convex"), { recursive: true });
  for (const name of PROJECT_LINKS) fs.symlinkSync(path.join(ROOT, name), path.join(dir, name));
  const schemaFile = path.join(dir, "convex", "schema.ts");
  const schema = fs.readFileSync(schemaFile, "utf8");
  const anchors = schema.split(SCHEMA_ANCHOR).length - 1;
  if (anchors !== 1) throw new Error(`expected the ${REJECTING_TABLE} schema anchor once in convex/schema.ts, found ${anchors}`);
  fs.writeFileSync(schemaFile, schema.replace(SCHEMA_ANCHOR, SCHEMA_NARROWED));
  return dir;
}

/** fetch that delegates to the real one and records which deploy endpoints were hit. */
function recordingFetch() {
  const endpoints = [];
  const impl = (url, init) => {
    endpoints.push(new globalThis.URL(url).pathname);
    return fetch(url, init);
  };
  return { endpoints, impl };
}

function tail(file) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
  } catch (err) {
    return `(no backend log: ${err.message})`;
  }
}

async function stop(child) {
  // A child that never spawned has no process to signal and never emits "exit".
  if (child.exitCode !== null || child.pid === undefined) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, STOP_GRACE_MS);
    child.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function main() {
  const binary = backendCachePath();
  if (!fs.existsSync(binary)) throw new Error(missingBinaryMessage(binary));
  const asset = backendAsset();
  if (!asset) throw new Error(`no pinned backend asset for ${process.platform}-${process.arch}`);
  if (!(await verifiedFile(binary, asset.binarySize, asset.binarySha256))) {
    throw new Error(`backend binary at ${binary} does not match the pinned size/SHA-256; run \`npm run fetch-backend\``);
  }
  if (!fs.existsSync(CONVEX_CLI)) throw new Error(`convex CLI not found at ${CONVEX_CLI}; run \`npm install\``);
  const cfgFile = configPath();
  if (!fs.existsSync(cfgFile)) {
    throw new Error(`no convex config at ${cfgFile}; run \`npm run dev\` once, or pass --config <path>`);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  if (!cfg.adminKey || !cfg.instanceSecret || !cfg.deploymentName) {
    throw new Error(`${cfgFile} is missing adminKey/instanceSecret/deploymentName`);
  }
  secrets.push(cfg.adminKey, cfg.instanceSecret);
  if (await isListening()) throw new Error(`something already answers on ${URL}; stop it first`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gs-schema-probe-"));
  const envFile = path.join(work, "selfhosted.env");
  fs.writeFileSync(envFile, `CONVEX_SELF_HOSTED_URL=${URL}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${cfg.adminKey}\n`, { mode: 0o600 });
  const logPath = path.join(work, "backend.log");
  // An OS-level file, not a pipe: spawnSync below blocks the event loop, and a full pipe
  // would stall the backend mid-push (same reason as prebake-seed.mjs).
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(
    binary,
    [
      "--port", String(CLOUD_PORT),
      "--site-proxy-port", String(SITE_PORT),
      "--instance-name", cfg.deploymentName,
      "--instance-secret", cfg.instanceSecret,
      "--interface", "127.0.0.1",
      "--disable-beacon",
      "--local-storage", path.join(work, "convex_local_storage"),
      path.join(work, "convex_local_backend.sqlite3"),
    ],
    { cwd: work, stdio: ["ignore", logFd, logFd] }
  );
  // WHY a listener: without one, a failed spawn (EACCES, ENOENT) is an unhandled "error" event
  // that kills Node with spawnargs (the instance secret) printed and the temp dir left behind.
  let startError = null;
  child.on("error", (err) => {
    startError = err;
  });
  const log = (line) => console.log(`  ${redact(line)}`);
  let failed = true;
  try {
    console.log(`• throwaway backend on ${URL} (data in ${work})`);
    await waitHealthy(child, () => startError);

    console.log("• bundle A: current functions");
    const bundleA = path.join(work, "bundle-a");
    const hashA = buildBundle({ projectDir: ROOT, envFile, workDir: work, bundleDir: bundleA, label: "a" });
    const first = await syncFunctions({ dataDir: work, bundleDir: bundleA, url: URL, adminKey: cfg.adminKey, log, requireBundle: true });
    assert.equal(first.status, "deployed", `bundle A did not deploy: ${first.error?.message}`);
    assert.equal(readMarker(work), hashA, "marker does not hold bundle A's hash after deploying it");

    console.log("• data the current schema accepts");
    await callFunction("mutation", "seed:seedWorkspace");
    const pagesBefore = (await callFunction("query", "pages:list")).length;
    assert.ok(pagesBefore >= 1, "seed produced no pages");
    console.log(`  pages:list → ${pagesBefore} pages`);

    console.log(`• bundle B: schema adds a required field to "${REJECTING_TABLE}"`);
    const bundleB = path.join(work, "bundle-b");
    const hashB = buildBundle({ projectDir: narrowedProject(work), envFile, workDir: work, bundleDir: bundleB, label: "b" });
    assert.notEqual(hashB, hashA, "the narrowed schema produced the same payload hash");

    console.log("• replaying bundle B");
    const recorder = recordingFetch();
    const second = await syncFunctions({ dataDir: work, bundleDir: bundleB, url: URL, adminKey: cfg.adminKey, fetch: recorder.impl, log, requireBundle: true });
    const pagesAfter = (await callFunction("query", "pages:list")).length;

    console.log("• assertions");
    assert.ok(recorder.endpoints.includes("/api/deploy2/start_push"), "start_push was never called");
    assert.ok(recorder.endpoints.includes("/api/deploy2/wait_for_schema"), "wait_for_schema was never called");
    assert.ok(!recorder.endpoints.includes("/api/deploy2/finish_push"), "finish_push was called after a failed schema check");
    console.log(`  endpoints → ${recorder.endpoints.join(", ")}`);
    assert.equal(readMarker(work), hashA, "functions.json no longer holds bundle A's hash");
    console.log(`  marker → ${hashA.slice(0, HASH_PREFIX_CHARS)} (bundle A; bundle B is ${hashB.slice(0, HASH_PREFIX_CHARS)})`);
    assert.equal(second.status, "failed", `expected status "failed", got "${second.status}"`);
    console.log(`  status → ${second.status}`);
    assert.equal(second.error?.tableName, REJECTING_TABLE, `error.tableName is ${second.error?.tableName}, not "${REJECTING_TABLE}"`);
    assert.match(second.error.message, new RegExp(`"${REJECTING_TABLE}"`), "error message does not name the table");
    console.log(`  error → ${redact(second.error.message).slice(0, 200)}`);
    assert.equal(pagesAfter, pagesBefore, `pages:list returned ${pagesAfter} pages after the failed push, ${pagesBefore} before`);
    console.log(`  pages:list after → ${pagesAfter} pages (old functions serving)`);
    failed = false;
  } finally {
    await stop(child);
    fs.closeSync(logFd);
    if (failed) console.error(`--- backend log tail ---\n${redact(tail(logPath))}\n---`);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log("✔ schema-failure probe passed");
}

main().catch((err) => {
  console.error(`✖ schema-failure probe: ${redact(err?.stack ?? err)}`);
  process.exit(1);
});
