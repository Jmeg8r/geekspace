// WHAT: Download the pinned Convex local backend (electron/backendVersion.mjs) from
// its GitHub release, verify zip and binary by size + SHA-256, and install it at
// the convex CLI's cache path, where prebake and the dev runtime look for it.
// WHY: `convex dev` only ever fetches whatever version.convex.dev calls "latest",
// so it can't produce the pinned version packaging needs. A no-op when the
// verified binary is already in place.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKEND_RELEASE_URL,
  BACKEND_VERSION,
  backendAsset,
  backendCachePath,
} from "../electron/backendVersion.mjs";
import { downloadVerifiedFile, verifiedFile } from "../electron/verifiedDownload.mjs";

function die(msg) {
  console.error(`✖ fetch-backend: ${msg}`);
  process.exit(1);
}

// WHY OS tools, not a zip library: no new dependency for one archive. macOS ships
// ditto; Windows 10+ ships bsdtar as tar.exe, which reads zip.
function unzip(zipFile, destDir) {
  if (process.platform === "darwin") {
    execFileSync("ditto", ["-xk", zipFile, destDir], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-xf", zipFile, "-C", destDir], { stdio: "inherit" });
  }
}

async function main() {
  const asset = backendAsset();
  if (!asset) {
    die(`no pinned backend asset for ${process.platform}-${process.arch} in electron/backendVersion.mjs`);
  }
  const target = backendCachePath();

  if (await verifiedFile(target, asset.binarySize, asset.binarySha256)) {
    console.log(`✔ Convex backend ${BACKEND_VERSION} already installed at ${target}`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gs-fetch-backend-"));
  try {
    const zipFile = path.join(work, asset.zip);
    const url = `${BACKEND_RELEASE_URL}/${asset.zip}`;
    console.log(`• downloading ${url}`);
    await downloadVerifiedFile(url, zipFile, asset.zipSize, asset.zipSha256);

    const extracted = path.join(work, "out");
    fs.mkdirSync(extracted);
    unzip(zipFile, extracted);
    const binary = path.join(extracted, path.basename(target));
    if (!(await verifiedFile(binary, asset.binarySize, asset.binarySha256))) {
      die(`unzipped ${path.basename(target)} does not match the pinned size/SHA-256`);
    }
    fs.chmodSync(binary, 0o755); // no-op on Windows (no +x bit to set)

    fs.mkdirSync(path.dirname(target), { recursive: true });
    // WHY copy + rename: the work dir may be on another volume than the cache, so
    // a bare rename can fail with EXDEV; the final rename within the cache dir
    // means a reader never sees a half-written binary.
    const staged = `${target}.${process.pid}.part`;
    fs.copyFileSync(binary, staged);
    fs.renameSync(staged, target);
    console.log(`✔ Convex backend ${BACKEND_VERSION} → ${target}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => die(err?.stack ?? String(err)));
