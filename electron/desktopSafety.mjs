// WHAT: the Electron shell's trust rules — which URLs are the app, which may leave it,
// and which local storage URLs Quick Look may fetch.
// WHY: these were prefix checks (`startsWith`), which `http://localhost:5190.evil.com`
// and `http://127.0.0.1@evil.com` both satisfied. Every rule here parses the URL and
// compares origin/host/port exactly. See docs/changes/2026-10-16-electron-sync/.
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const STORAGE_PATH = "/api/storage/";

function parse(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/**
 * True only for the app's own pages: the exact dev-server origin (dev), or the `file:`
 * URL of the app's built index.html (packaged). Never any other file or host.
 */
export function isAppUrl(url, { devServerUrl, indexFile }) {
  const u = parse(url);
  if (!u || u.username || u.password) return false;
  if (devServerUrl) {
    const dev = parse(devServerUrl);
    if (dev && u.origin === dev.origin) return true;
  }
  if (u.protocol === "file:" && indexFile) {
    try {
      return path.resolve(fileURLToPath(u)) === path.resolve(indexFile);
    } catch {
      return false;
    }
  }
  return false;
}

/** Links the OS may open: web and mail only — never file:, smb:, or app schemes. */
export function isSafeExternalUrl(url) {
  const u = parse(url);
  return Boolean(u && EXTERNAL_PROTOCOLS.has(u.protocol));
}

/** A file in the local Convex deployment's storage, and nothing that merely looks like one. */
export function isLocalStorageUrl(url, port) {
  const u = parse(url);
  return Boolean(
    u &&
      u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      u.port === String(port) &&
      !u.username &&
      !u.password &&
      u.pathname.startsWith(STORAGE_PATH)
  );
}
