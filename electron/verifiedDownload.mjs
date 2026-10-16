// WHAT: download a file and publish it only when its size and SHA-256 match.
// WHY: the whisper model is ~148 MB of executable-adjacent weights fetched over the
// network; a truncated, swapped or redirected download must never be treated as the
// model. Adapted from PR #28.
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** True only for a regular file (not a symlink) of exactly `size` bytes hashing to `sha256`. */
export async function verifiedFile(file, size, sha256) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Stream `url` to a unique temporary file, hashing as it goes, and rename it to
 * `destination` only after the byte count and hash match. HTTPS only, redirects
 * followed by hand so a downgrade to HTTP is refused. The temporary file is always removed.
 */
export async function downloadVerifiedFile(url, destination, size, sha256, onProgress) {
  const temporary = `${destination}.${randomUUID()}.part`;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    let response;
    for (let redirects = 0; ; redirects++) {
      if (new URL(url).protocol !== "https:") throw new Error("Model download requires HTTPS");
      response = await fetch(url, { redirect: "manual", signal });
      if (response.status < 300 || response.status >= 400) break;
      await response.body?.cancel();
      const next = response.headers.get("location");
      if (!next || redirects >= MAX_REDIRECTS) throw new Error("Invalid model download redirect");
      url = new URL(next, url).href;
    }
    if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status})`);

    let bytes = 0;
    const hash = createHash("sha256");
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > size) {
          callback(new Error("Model download exceeds expected size"));
          return;
        }
        hash.update(chunk);
        onProgress?.(Math.floor((100 * bytes) / size));
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      verify,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal }
    );
    if (bytes !== size || hash.digest("hex") !== sha256) {
      throw new Error("Model download failed integrity verification");
    }
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
