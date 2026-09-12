import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyDataDirectory,
  ensureDataDirectory,
} from "../electron/dataDirectory.mjs";
import {
  externalUrl,
  isAppUrl,
  localStorageUrl,
  viewerFilename,
  downloadDocument,
} from "../electron/desktopSafety.mjs";
import http from "node:http";
const roots = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-data-test-"));
  roots.push(root);
  const source = path.join(root, "source");
  const destination = path.join(root, "data");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "config.json"),
    JSON.stringify({
      adminKey: "fixture",
      deploymentName: "fixture",
      instanceSecret: "fixture",
    }),
  );
  fs.writeFileSync(
    path.join(source, "convex_local_backend.sqlite3"),
    "synthetic sqlite payload",
  );
  fs.writeFileSync(
    path.join(source, "convex_local_backend.sqlite3-wal"),
    "synthetic committed wal",
  );
  return { root, source, destination };
}
describe("data preservation", () => {
  it("refuses to seed over partial or corrupt existing data", () => {
    const { source, destination } = fixture();
    fs.mkdirSync(destination);
    const old = path.join(destination, "convex_local_backend.sqlite3");
    fs.writeFileSync(old, "user data");
    expect(() => ensureDataDirectory(destination, source)).toThrow();
    expect(fs.readFileSync(old, "utf8")).toBe("user data");
  });
  it("keeps every forced-migration backup, including an old .bak", () => {
    const { source, destination } = fixture();
    fs.mkdirSync(`${destination}.bak`);
    fs.writeFileSync(`${destination}.bak/keep`, "old backup");
    expect(ensureDataDirectory(destination, source)).toBe(true);
    fs.writeFileSync(
      `${destination}/convex_local_backend.sqlite3`,
      "first workspace",
    );
    const first = copyDataDirectory(source, destination, { replace: true });
    fs.writeFileSync(
      `${destination}/convex_local_backend.sqlite3`,
      "second workspace",
    );
    const second = copyDataDirectory(source, destination, { replace: true });
    expect(
      fs.readFileSync(`${first}/convex_local_backend.sqlite3`, "utf8"),
    ).toBe("first workspace");
    expect(
      fs.readFileSync(`${second}/convex_local_backend.sqlite3`, "utf8"),
    ).toBe("second workspace");
    expect(fs.readFileSync(`${destination}.bak/keep`, "utf8")).toBe(
      "old backup",
    );
    expect(
      fs.readFileSync(
        `${destination}/convex_local_backend.sqlite3-wal`,
        "utf8",
      ),
    ).toBe("synthetic committed wal");
  });
  it("rejects an invalid source before moving the existing workspace", () => {
    const { source, destination } = fixture();
    ensureDataDirectory(destination, source);
    fs.unlinkSync(`${source}/convex_local_backend.sqlite3`);
    expect(() =>
      copyDataDirectory(source, destination, { replace: true }),
    ).toThrow();
    expect(fs.existsSync(`${destination}/config.json`)).toBe(true);
  });
});
describe("desktop boundaries", () => {
  it("trusts only the actual entry page and harmless fragments", () => {
    const entry = "file:///Applications/Geekspace.app/dist/index.html";
    expect(isAppUrl(`${entry}#page`, entry)).toBe(true);
    expect(isAppUrl("file:///tmp/import.html", entry)).toBe(false);
    expect(isAppUrl("http://localhost:51730/", "http://localhost:5173/")).toBe(
      false,
    );
    expect(
      isAppUrl("http://localhost:5173@evil.example/", "http://localhost:5173/"),
    ).toBe(false);
  });
  it.each([
    "file:///tmp/run.command",
    "javascript:alert(1)",
    "ms-msdt:/anything",
    "https://user:pass@example.com",
  ])("rejects unsafe external link %s", (value) =>
    expect(() => externalUrl(value)).toThrow(),
  );
  it.each([
    "http://127.0.0.1.evil.example/api/storage/abc",
    "http://127.0.0.1:9999/api/storage/abc",
    "http://127.0.0.1:3210/api/query",
    "http://127.0.0.1:3210@evil.example/api/storage/abc",
  ])("rejects non-storage URL %s", (value) =>
    expect(() => localStorageUrl(value, "http://127.0.0.1:3210")).toThrow(),
  );
  it("permits workspace storage and supported viewer names", () => {
    expect(
      localStorageUrl(
        "http://127.0.0.1:3210/api/storage/abc-123",
        "http://127.0.0.1:3210",
      ),
    ).toContain("/api/storage/");
    expect(viewerFilename("..\\notes.pdf")).toBe("document-notes.pdf");
    expect(() => viewerFilename("run.command")).toThrow();
    expect(() => viewerFilename("run.lnk")).toThrow();
  });
  it("rejects redirect and oversized chunked downloads; writes exact allowed bytes", async () => {
    const { root } = fixture();
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/ok" });
        res.end();
      } else {
        res.writeHead(200);
        res.write("12345");
        res.end("67890");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      await expect(
        downloadDocument(`${base}/redirect`, path.join(root, "redirect"), 10),
      ).rejects.toThrow();
      await expect(
        downloadDocument(`${base}/large`, path.join(root, "large"), 5),
      ).rejects.toThrow("size limit");
      await downloadDocument(`${base}/ok`, path.join(root, "ok"), 10);
      expect(fs.readFileSync(path.join(root, "ok"), "utf8")).toBe("1234567890");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

it("rejects a corrupt model with the correct size", async () => {
  const { verifiedFile } = await import("../electron/verifiedDownload.mjs");
  const { createHash } = await import("node:crypto");
  const { root } = fixture();
  const file = path.join(root, "model.bin");
  fs.writeFileSync(file, "good");
  const hash = createHash("sha256").update("good").digest("hex");
  expect(await verifiedFile(file, 4, hash)).toBe(true);
  fs.writeFileSync(file, "bad!");
  expect(await verifiedFile(file, 4, hash)).toBe(false);
  expect(await verifiedFile(file, 5, hash)).toBe(false);
});
it("refuses factory seeding when an interrupted migration left a backup", () => {
  const { source, destination } = fixture();
  fs.mkdirSync(`${destination}.bak-interrupted`);
  expect(() => ensureDataDirectory(destination, source)).toThrow(
    "backup exists",
  );
  expect(fs.existsSync(destination)).toBe(false);
});

it("publishes only complete verified downloads and preserves an old file on failure", async () => {
  const { downloadVerifiedFile } =
    await import("../electron/verifiedDownload.mjs");
  const { createHash } = await import("node:crypto");
  const { root } = fixture();
  const file = path.join(root, "download.bin");
  fs.writeFileSync(file, "old content");
  const hash = createHash("sha256").update("good").digest("hex");
  vi.stubGlobal("fetch", async () => new Response("bad!"));
  await expect(
    downloadVerifiedFile("https://fixture.invalid/model", file, 4, hash),
  ).rejects.toThrow("integrity");
  expect(fs.readFileSync(file, "utf8")).toBe("old content");
  expect(fs.readdirSync(root).some((name) => name.endsWith(".part"))).toBe(
    false,
  );
  vi.stubGlobal("fetch", async () => new Response("good"));
  await downloadVerifiedFile("https://fixture.invalid/model", file, 4, hash);
  expect(fs.readFileSync(file, "utf8")).toBe("good");
});
