import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadVerifiedFile, verifiedFile } from "../electron/verifiedDownload.mjs";

// WHAT: the whisper model is only published when its size and SHA-256 match.
// See docs/changes/2026-10-15-meetings/.

const BYTES = new TextEncoder().encode("pretend this is a whisper model");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const URL_OK = "https://models.test/ggml.bin";

let dir = "";
const dest = () => path.join(dir, "model.bin");
const leftovers = async () => (await fs.readdir(dir)).filter((f) => f !== "model.bin");

function serve(body: Uint8Array, status = 200, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(status >= 300 && status < 400 ? null : body, { status, headers }))
  );
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gs-verified-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("downloadVerifiedFile", () => {
  it("publishes a file whose size and hash match", async () => {
    serve(BYTES);
    await downloadVerifiedFile(URL_OK, dest(), BYTES.length, SHA);
    expect(await verifiedFile(dest(), BYTES.length, SHA)).toBe(true);
    expect(await leftovers()).toEqual([]);
  });

  it("rejects a hash mismatch and leaves nothing behind", async () => {
    serve(BYTES);
    await expect(downloadVerifiedFile(URL_OK, dest(), BYTES.length, "0".repeat(64))).rejects.toThrow(
      /integrity/i
    );
    await expect(fs.access(dest())).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("rejects a download larger than expected", async () => {
    serve(new Uint8Array(BYTES.length + 10));
    await expect(downloadVerifiedFile(URL_OK, dest(), BYTES.length, SHA)).rejects.toThrow(/size/i);
    await expect(fs.access(dest())).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("refuses plain HTTP, including via a redirect", async () => {
    serve(BYTES);
    await expect(downloadVerifiedFile("http://models.test/x", dest(), BYTES.length, SHA)).rejects.toThrow(
      /https/i
    );
    serve(BYTES, 302, { location: "http://evil.test/x" });
    await expect(downloadVerifiedFile(URL_OK, dest(), BYTES.length, SHA)).rejects.toThrow(/https/i);
  });
});

describe("verifiedFile", () => {
  it("rejects a wrong-size file and a missing file", async () => {
    await fs.writeFile(dest(), BYTES.slice(1));
    expect(await verifiedFile(dest(), BYTES.length, SHA)).toBe(false);
    expect(await verifiedFile(path.join(dir, "absent.bin"), BYTES.length, SHA)).toBe(false);
  });

  it("rejects a symlink even to a good file", async () => {
    const real = path.join(dir, "real.bin");
    await fs.writeFile(real, BYTES);
    await fs.symlink(real, dest());
    expect(await verifiedFile(dest(), BYTES.length, SHA)).toBe(false);
  });
});
