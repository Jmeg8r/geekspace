// WHAT: The packaged Geekspace app's per-user Convex data directory —
// win32: %APPDATA%\Geekspace\convex; darwin/else: ~/Library/Application
// Support/Geekspace/convex.
// WHY: deploy-local.mjs and migrate-local-data.mjs both need this exact
// answer and must never diverge, so it lives here once instead of being
// duplicated inline. Mirrors Electron's app.getPath("appData") without
// importing electron — same rationale as electron/readerMcp.mjs's
// appSupportDir, which stays separate on purpose: electron/ modules are
// self-contained and don't reach into scripts/.
import os from "node:os";
import path from "node:path";

export function packagedConvexDir() {
  return process.platform === "win32"
    ? path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "Geekspace",
        "convex"
      )
    : path.join(os.homedir(), "Library", "Application Support", "Geekspace", "convex");
}
