// WHAT: the plan PR 3c part 2 soak logger. Samples the resident memory of gs-capture and of
// every Geekspace.app process, plus how many shot and segment files today's media folder
// holds, and judges spec R2: each process grows less than --limit-mb from the --warmup mark.
// WHY files and RSS only: they need no access to captured content. Nothing here reads a
// frame, a segment or OCR text, so the CSV and summary are safe to commit as evidence.
// Usage:
//   node scripts/soak-rss.mjs [--minutes 120] [--interval-sec 30] [--warmup-minutes 10]
//                             [--limit-mb 50] [--out <dir>]
// Exits 1 if a role grew past the limit, the helper was never seen, or it restarted.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeSoak } from "./lib/dayRecorderTools.mjs";

const args = process.argv.slice(2);
function num(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = Number(args[i + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number`);
  return value;
}
const MINUTES = num("minutes", 120);
const INTERVAL_SEC = num("interval-sec", 30);
const WARMUP_MIN = num("warmup-minutes", 10);
const LIMIT_MB = num("limit-mb", 50);
const outIndex = args.indexOf("--out");
const OUT = outIndex >= 0 ? args[outIndex + 1] : path.join(os.homedir(), "gs-part2-evidence");
const MEDIA_ROOT = process.env.GS_MEDIA_ROOT ?? path.join(os.homedir(), "Library", "Application Support", "Geekspace", "day-recorder");
const KB_PER_MB = 1024;

/** Which part of the app a process is, from its executable path. */
function role(comm) {
  if (comm.endsWith("/gs-capture") || comm === "gs-capture") return "helper";
  if (!comm.includes("Geekspace.app/")) return null;
  if (comm.endsWith("Contents/MacOS/Geekspace")) return "main";
  if (comm.includes("(Renderer)")) return "renderer";
  if (comm.includes("(GPU)")) return "gpu";
  if (comm.includes("convex-local-backend")) return "backend";
  return "otherHelper";
}

function sample() {
  const out = execFileSync("ps", ["-axo", "pid=,rss=,comm="], { encoding: "utf8" });
  const byRole = {};
  const helperPids = [];
  for (const raw of out.split("\n")) {
    const m = raw.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const r = role(m[3]);
    if (!r) continue;
    byRole[r] = (byRole[r] ?? 0) + Number(m[2]) / KB_PER_MB;
    if (r === "helper") helperPids.push(Number(m[1]));
  }
  return { byRole, helperPids };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Counts only: how many shots and segments exist across every day folder. WHY all of them:
 * a soak that crosses local midnight writes into two folders, and counting only today's
 * made the totals drop to zero at midnight (first part 2 soak, 2026-10-21/22).
 */
function mediaCounts() {
  let names = [];
  let days = [];
  try {
    days = fs.readdirSync(MEDIA_ROOT).filter((d) => DAY_RE.test(d));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  for (const day of days) names = names.concat(fs.readdirSync(path.join(MEDIA_ROOT, day)));
  return {
    shots: names.filter((n) => n.startsWith("shot-")).length,
    segments: names.filter((n) => n.startsWith("sys-") && !n.startsWith(".")).length,
    partials: names.filter((n) => n.startsWith(".partial-")).length,
  };
}

const ROLES = ["helper", "main", "renderer", "gpu", "backend", "otherHelper"];
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const csvPath = path.join(OUT, `soak-rss-${stamp}.csv`);
fs.writeFileSync(csvPath, `t,elapsedMin,${ROLES.map((r) => `${r}MB`).join(",")},helperPids,shots,segments,partials\n`);

const started = Date.now();
const rows = [];
console.log(`soak-rss: ${MINUTES} min every ${INTERVAL_SEC} s -> ${csvPath}`);
while (Date.now() - started < MINUTES * 60_000) {
  const { byRole, helperPids } = sample();
  const media = mediaCounts();
  const elapsedMin = (Date.now() - started) / 60_000;
  const row = { elapsedMin, byRole, helperPids, ...media };
  rows.push(row);
  fs.appendFileSync(
    csvPath,
    `${new Date().toISOString()},${elapsedMin.toFixed(2)},${ROLES.map((r) => (byRole[r] ?? 0).toFixed(1)).join(",")},${helperPids.join(" ")},${media.shots},${media.segments},${media.partials}\n`
  );
  await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
}

// R2, judged in scripts/lib/dayRecorderTools.mjs (tested there): growth from the warmup mark,
// and the helper present in every sample with one pid.
const verdict = judgeSoak(rows, { warmupMinutes: WARMUP_MIN, limitMB: LIMIT_MB });
const { growth, failures } = verdict;
const last = rows.at(-1);
const summary = {
  minutes: MINUTES, intervalSec: INTERVAL_SEC, warmupMinutes: WARMUP_MIN, limitMB: LIMIT_MB,
  samples: rows.length, helperPids: verdict.helperPids, growth,
  media: { shots: last.shots, segments: last.segments, partials: last.partials },
  pass: verdict.pass, failures, csv: path.basename(csvPath),
};
fs.writeFileSync(path.join(OUT, `soak-rss-${stamp}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.pass ? 0 : 1);
