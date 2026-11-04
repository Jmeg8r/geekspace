// WHAT: turn the Day Recorder on or off, and mark moments in an evidence log, for the plan
// PR 3c part 2 proofs (docs/changes/2026-10-18-day-recorder/part2-runbook.md).
// WHY a script: the renderer's controls arrive in PR 3d/3e. The main process already follows
// `dayRecorder.getSettings` by subscription, so writing the settings through the local
// backend is exactly what the future Settings switch will do.
// Usage:
//   node scripts/day-recorder-ctl.mjs on [--denylist id,id] [--shot-sec 30]
//   node scripts/day-recorder-ctl.mjs off
//   node scripts/day-recorder-ctl.mjs settings
//   node scripts/day-recorder-ctl.mjs mark <label>      (appends "<ISO time> <label>")
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { CtlUsageError, describeCtlError, safeSettings } from "./lib/dayRecorderTools.mjs";

const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";
const EVIDENCE_DIR = process.env.GS_EVIDENCE_DIR ?? path.join(os.homedir(), "gs-part2-evidence");
const LABEL_RE = /^[A-Za-z0-9 ._:-]{1,80}$/;

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new CtlUsageError(`--${name} needs a value`);
  return value;
}

async function main([command, ...args]) {
  // No client logger: it prints the backend's log lines and errors itself, before the handler
  // below, and those can name denylisted apps (Codex re-check of #80).
  const client = new ConvexHttpClient(CONVEX_URL, { logger: false });
  switch (command) {
    case "on": {
      const denylist = flag(args, "denylist");
      const shotSec = flag(args, "shot-sec");
      await client.mutation(api.dayRecorder.updateSettings, {
        enabled: true,
        // As the app's own control does: turning on clears a saved pause (dayRecorderIpc.mjs).
        paused: false,
        ...(denylist !== undefined && { denylist: denylist.split(",").filter(Boolean) }),
        ...(shotSec !== undefined && { shotSec: Number(shotSec) }),
      });
      // The denylist is printed as a count: a denylisted app is never named (protocol.md).
      console.log("Day Recorder: on", JSON.stringify(safeSettings(await client.query(api.dayRecorder.getSettings, {}))));
      return;
    }
    case "off":
      await client.mutation(api.dayRecorder.updateSettings, { enabled: false });
      console.log("Day Recorder: off");
      return;
    case "settings":
      console.log(JSON.stringify(safeSettings(await client.query(api.dayRecorder.getSettings, {})), null, 2));
      return;
    case "mark": {
      const label = args.join(" ");
      if (!LABEL_RE.test(label)) throw new CtlUsageError("mark needs a short label: letters, digits, spaces, . _ : -");
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      const line = `${new Date().toISOString()} ${label}\n`;
      fs.appendFileSync(path.join(EVIDENCE_DIR, "markers.log"), line);
      process.stdout.write(line);
      return;
    }
    default:
      throw new CtlUsageError("usage: day-recorder-ctl.mjs <on [--denylist id,id] [--shot-sec N] | off | settings | mark <label>>");
  }
}

main(process.argv.slice(2)).catch((err) => {
  // Only this script's own errors are printed as they are; anything else (the backend's
  // included) goes through describeCtlError, which never echoes the request.
  console.error(`day-recorder-ctl: ${err instanceof CtlUsageError ? err.message : describeCtlError(err, CONVEX_URL)}`);
  process.exit(1);
});
