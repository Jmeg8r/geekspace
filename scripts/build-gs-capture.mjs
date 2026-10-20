// WHAT: Build-time step that compiles the Day Recorder's native helper (native/gs-capture)
// in release mode, so `npm run package` can ship it in Contents/Resources/gs-capture.
// WHY: electron-builder copies it through mac.extraResources and signs it with the app's
// entitlementsInherit; no extra signing config is needed (spike-findings.md Q7). The helper
// is ScreenCaptureKit, CoreAudio and Vision, so it exists on macOS only: on any other
// platform this step says so and does nothing, rather than failing the Windows package.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = path.join(ROOT, "native", "gs-capture");
// package.json's mac.extraResources entry reads exactly this path.
const HELPER_PATH = path.join(PACKAGE_DIR, ".build", "release", "gs-capture");

function fail(message) {
  console.error(`build-gs-capture: ${message}`);
  process.exit(1);
}

if (process.platform !== "darwin") {
  console.log(`build-gs-capture: skipped on ${process.platform}; the Day Recorder helper is macOS-only`);
  process.exit(0);
}

const build = spawnSync("swift", ["build", "-c", "release", "--product", "gs-capture", "--package-path", PACKAGE_DIR],
  { stdio: ["ignore", "inherit", "inherit"] });
if (build.error) fail(`swift could not start (${build.error.code ?? build.error.message}); install the Xcode command-line tools`);
if (build.status !== 0) fail(`swift build exited ${build.status}`);

// A build that "succeeds" without producing the binary must not reach electron-builder,
// which would ship the app without its helper (a missing-capability failure that only shows
// on end-user machines).
let stat;
try {
  stat = fs.statSync(HELPER_PATH);
} catch (error) {
  fail(`swift build reported success but ${path.relative(ROOT, HELPER_PATH)} is missing (${error.code})`);
}
if (!stat.isFile() || (stat.mode & 0o111) === 0) fail(`${path.relative(ROOT, HELPER_PATH)} is not an executable file`);
console.log(`build-gs-capture: ✔ ${path.relative(ROOT, HELPER_PATH)} (${stat.size} bytes)`);
