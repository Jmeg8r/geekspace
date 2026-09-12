import fs from "node:fs/promises";
import path from "node:path";

export function isAppUrl(value, entryUrl) {
  try {
    const url = new URL(value);
    const entry = new URL(entryUrl);
    return (
      !url.username &&
      !url.password &&
      url.protocol === entry.protocol &&
      url.host === entry.host &&
      url.pathname === entry.pathname
    );
  } catch {
    return false;
  } // malformed links are never internal
}

export function externalUrl(value) {
  if (typeof value !== "string") throw new Error("Invalid link");
  const url = new URL(value);
  if (
    !["http:", "https:", "mailto:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Unsupported external link");
  return url.href;
}

export function localStorageUrl(value, base) {
  if (typeof value !== "string") throw new Error("Invalid storage URL");
  const url = new URL(value);
  const expected = new URL(base);
  if (
    url.origin !== expected.origin ||
    url.username ||
    url.password ||
    !/^\/api\/storage\/[a-zA-Z0-9_-]+$/.test(url.pathname) ||
    url.hash
  ) {
    throw new Error("Only this workspace's local storage files can be opened");
  }
  return url.href;
}

const VIEWER_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".rtf",
  ".csv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".tif",
  ".tiff",
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
  ".mov",
  ".webm",
]);
export function viewerFilename(value) {
  const basename = path.win32.basename(path.basename(String(value ?? "")));
  if (!VIEWER_EXTENSIONS.has(path.extname(basename).toLowerCase()))
    throw new Error(
      "This file type cannot be opened through the document viewer",
    );
  return `document-${basename.replace(/[^\w.\- ]+/g, "_")}`;
}

export async function downloadDocument(
  url,
  destination,
  maxBytes = 64 * 1024 * 1024,
) {
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await res.body?.cancel();
    throw new Error("File is too large for the document viewer (64 MiB limit)");
  }
  if (!res.body) throw new Error("Empty file response");
  const file = await fs.open(destination, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > maxBytes)
        throw new Error("File exceeds the document viewer size limit");
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        if (!bytesWritten)
          throw new Error("Could not finish writing the document");
        offset += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
}
