import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BACKEND_ASSETS,
  BACKEND_VERSION,
  backendCachePath,
  missingBinaryMessage,
} from "../electron/backendVersion.mjs";

// WHAT: the Convex backend version lives in one module that the build and the runtime
// both import. See docs/changes/2026-10-16-backend-pin/.

const ROOT = path.join(__dirname, "..");
const SHA256 = /^[0-9a-f]{64}$/;

describe("backend version pin", () => {
  it("is a precompiled release tag", () => {
    expect(BACKEND_VERSION).toMatch(/^precompiled-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}$/);
  });

  it.each(["scripts/prebake-seed.mjs", "electron/convexBackend.mjs"])(
    "is not duplicated in %s",
    (file) => {
      expect(fs.readFileSync(path.join(ROOT, file), "utf8")).not.toMatch(/precompiled-\d/);
    }
  );

  it.each(["darwin-arm64", "darwin-x64", "win32-x64"])("pins the %s asset", (key) => {
    const asset = BACKEND_ASSETS[key];
    expect(asset.zip).toMatch(/^convex-local-backend-.+\.zip$/);
    expect(asset.zipSha256).toMatch(SHA256);
    expect(asset.zipSize).toBeGreaterThan(0);
    expect(asset.binarySha256).toMatch(SHA256);
    expect(asset.binarySize).toBeGreaterThan(0);
  });
});

describe("backendCachePath", () => {
  it("uses the CLI's ~/.cache layout on macOS", () => {
    expect(backendCachePath({ platform: "darwin", env: {}, homedir: "/Users/j" })).toBe(
      path.join("/Users/j", ".cache", "convex", "binaries", BACKEND_VERSION, "convex-local-backend")
    );
  });

  it("uses %LOCALAPPDATA% and .exe on Windows", () => {
    expect(
      backendCachePath({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, homedir: "C:\\Users\\j" })
    ).toBe(path.join("C:\\L", "convex", "binaries", BACKEND_VERSION, "convex-local-backend.exe"));
  });

  it("falls back to AppData\\Local when LOCALAPPDATA is unset", () => {
    expect(backendCachePath({ platform: "win32", env: {}, homedir: "C:\\Users\\j" })).toBe(
      path.join("C:\\Users\\j", "AppData", "Local", "convex", "binaries", BACKEND_VERSION, "convex-local-backend.exe")
    );
  });
});

describe("missingBinaryMessage", () => {
  it("names the version and the command that fetches it", () => {
    const msg = missingBinaryMessage("/x/convex-local-backend");
    expect(msg).toContain("/x/convex-local-backend");
    expect(msg).toContain(BACKEND_VERSION);
    expect(msg).toContain("npm run fetch-backend");
    expect(msg).not.toContain("npm run dev");
  });
});
