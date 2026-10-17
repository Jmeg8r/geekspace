// WHAT: The one place the Convex local-backend version is pinned, with the size and
// SHA-256 of each platform's release asset, plus where the binary lives on disk.
// WHY: the convex CLI pins nothing — `convex dev` downloads whatever
// version.convex.dev calls "latest" — so the packaged app must pin its own. The
// build (scripts/prebake-seed.mjs, scripts/fetch-backend.mjs) and the runtime
// (convexBackend.mjs) all import this; it lives in electron/ because that is what
// ships in the asar. Bumping it migrates every user's data forward, one way (see
// docs/changes/2026-10-16-backend-pin/), so bump it on purpose: change the version,
// re-hash the assets, re-run prebake.
import os from "node:os";
import path from "node:path";

export const BACKEND_VERSION = "precompiled-2026-10-10-72ce13c";

export const BACKEND_RELEASE_URL = `https://github.com/get-convex/convex-backend/releases/download/${BACKEND_VERSION}`;

// Keyed by `${process.platform}-${process.arch}`; asset names match the convex CLI's.
export const BACKEND_ASSETS = {
  "darwin-arm64": {
    zip: "convex-local-backend-aarch64-apple-darwin.zip",
    zipSize: 55305787,
    zipSha256: "fbaf2dcff35c57a16f1f6a804fd505ba562fcc7f6898c170b4e0f7f0c46c0881",
    binarySize: 172450256,
    binarySha256: "ddcb97720542fde286a629a4a498c528c5fa9dfa47c5642dfe1d7dc19bd20db6",
  },
  "darwin-x64": {
    zip: "convex-local-backend-x86_64-apple-darwin.zip",
    zipSize: 59214080,
    zipSha256: "a621a16688bad0a5f06726956e67c58af574e82ed98ab83d4889fd8cd6b2bc94",
    binarySize: 185956928,
    binarySha256: "5d936067eecc6868f20cdd20f281b5f95f6207a7f068286e22c21cd3ec199472",
  },
  "win32-x64": {
    zip: "convex-local-backend-x86_64-pc-windows-msvc.zip",
    zipSize: 49768510,
    zipSha256: "1f7cde2e8456b3ffdc408aeee5a9f4d55e29121ecfd85f0ea9f9934ec02cbe32",
    binarySize: 134515200,
    binarySha256: "19b2f9a0fbbd11b4bcb583d71fce54511a3eb9f8f19c68d5739167a0ec7c191a",
  },
};

/** The pinned asset for this machine, or null on a platform we don't package for. */
export function backendAsset(platform = process.platform, arch = process.arch) {
  return BACKEND_ASSETS[`${platform}-${arch}`] ?? null;
}

/**
 * Where the convex CLI caches the pinned binary, and where fetch-backend puts it.
 * WHY the platform branch: verified on-machine that the CLI caches under
 * %LOCALAPPDATA% on Windows, vs. the XDG-ish ~/.cache everywhere else.
 */
export function backendCachePath({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(homedir, "AppData", "Local");
    return path.join(localAppData, "convex", "binaries", BACKEND_VERSION, "convex-local-backend.exe");
  }
  return path.join(homedir, ".cache", "convex", "binaries", BACKEND_VERSION, "convex-local-backend");
}

/** The prebake error for a missing binary: says which version, and how to get it. */
export function missingBinaryMessage(binaryPath) {
  return (
    `backend binary missing at ${binaryPath}\n` +
    `  Geekspace pins Convex backend ${BACKEND_VERSION} (electron/backendVersion.mjs).\n` +
    "  Run `npm run fetch-backend` to download and verify it."
  );
}
