// WHAT: runs the BUNDLED gs-capture helper from inside a signed Geekspace.app, the way the PR 3c
// supervisor will, and writes what happened to a JSON file.
// WHY: TCC attributes the helper's screen and audio capture to the responsible process. Run by
// the signed app binary in Node mode (`open` with ELECTRON_RUN_AS_NODE=1), Geekspace is that
// process, so this proves the packaged helper works under the packaged app's grants, not the
// terminal's (plan PR 3b-3; the spike's Q7 method, now kept in the repo).
// Usage (via `open`): Geekspace --args signed-run.cjs <out.json> <media-root> <denylist> <seconds>
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [out, mediaRoot, denylist, seconds] = process.argv.slice(2);
// .../Geekspace.app/Contents/MacOS/Geekspace -> .../Contents/Resources/gs-capture
const helper = path.join(path.dirname(process.execPath), "..", "Resources", "gs-capture");
const started = Date.now();
const child = spawn(helper, ["run", "--media-root", mediaRoot, "--denylist", denylist, "--shot-sec", "2",
  "--segment-sec", "3", "--duration", seconds], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const write = (result) => fs.writeFileSync(out, `${JSON.stringify({ execPath: process.execPath, helper, ...result }, null, 2)}\n`);
child.on("error", (error) => write({ spawnError: error.code ?? error.message }));
child.on("close", (code, signal) => {
  // ocrText can carry real screen content: keep only its length (the repo is public).
  const lines = stdout.split("\n").filter((line) => line.trim()).map((line) => {
    const parsed = JSON.parse(line);
    if (typeof parsed.ocrText === "string") parsed.ocrText = { chars: parsed.ocrText.length };
    return parsed;
  });
  write({ exitCode: code, signal, ms: Date.now() - started, stderr: stderr.slice(0, 2000), lines });
});
