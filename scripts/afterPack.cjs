// WHAT: electron-builder afterPack hook. Makes the bundled Convex backend binary
// executable and strips the macOS quarantine flag from the packaged .app.
// WHY: extraResources copies files without preserving the +x bit, so the spawned
// binary would be non-executable; and an unsigned binary inside a quarantined
// .app would be Gatekeeper-blocked when the app tries to spawn it.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const appName = context.packager.appInfo.productFilename; // "Geekspace"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const binary = path.join(appPath, "Contents", "Resources", "convex-local-backend");

  if (!fs.existsSync(binary)) {
    console.warn(`afterPack: WARNING — backend binary not found at ${binary}`);
    return;
  }

  fs.chmodSync(binary, 0o755);

  // Best-effort: a locally built .app usually isn't quarantined, but strip it
  // anyway so a copied/AirDropped build still spawns the binary cleanly.
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", appPath]);
  } catch {
    /* nothing to strip — fine */
  }

  console.log("afterPack: backend binary made executable (+ de-quarantined).");
};
