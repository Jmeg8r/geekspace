import { describe, expect, it } from "vitest";
import { isAppUrl, isLocalStorageUrl, isSafeExternalUrl } from "../electron/desktopSafety.mjs";

// WHAT: the Electron shell's trust rules, parsed rather than prefix-matched.
// See docs/changes/2026-10-16-electron-sync/.

const dev = { devServerUrl: "http://localhost:5190", indexFile: "/Applications/Geekspace.app/Contents/Resources/app/dist/index.html" };
const packaged = { devServerUrl: undefined, indexFile: dev.indexFile };

describe("isAppUrl", () => {
  it("accepts the dev server origin and the packaged index", () => {
    expect(isAppUrl("http://localhost:5190/", dev)).toBe(true);
    expect(isAppUrl("http://localhost:5190/src/main.tsx?t=1", dev)).toBe(true);
    expect(isAppUrl(`file://${packaged.indexFile}`, packaged)).toBe(true);
    expect(isAppUrl(`file://${packaged.indexFile}#/page/abc`, packaged)).toBe(true);
  });

  it("refuses look-alike hosts that a prefix check let through", () => {
    expect(isAppUrl("http://localhost:5190.evil.com/", dev)).toBe(false);
    expect(isAppUrl("http://localhost:51900/", dev)).toBe(false);
    expect(isAppUrl("http://localhost:5190@evil.com/", dev)).toBe(false);
  });

  it("refuses any file: URL other than the app's own index", () => {
    expect(isAppUrl("file:///etc/passwd", packaged)).toBe(false);
    expect(isAppUrl("file:///Users/x/Downloads/evil.html", packaged)).toBe(false);
    expect(isAppUrl(`file://${packaged.indexFile}`, dev)).toBe(true);
  });

  it("refuses the dev origin once packaged, and junk", () => {
    expect(isAppUrl("http://localhost:5190/", packaged)).toBe(false);
    expect(isAppUrl("not a url", dev)).toBe(false);
    expect(isAppUrl("", dev)).toBe(false);
  });
});

describe("isSafeExternalUrl", () => {
  it("allows web and mail links", () => {
    expect(isSafeExternalUrl("https://example.com/a")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("mailto:someone@example.com")).toBe(true);
  });

  it("refuses schemes that can launch local programs or files", () => {
    for (const url of ["file:///Applications/Calculator.app", "smb://host/share", "vscode://x", "javascript:alert(1)", "ssh://h"]) {
      expect(isSafeExternalUrl(url)).toBe(false);
    }
  });
});

describe("isLocalStorageUrl", () => {
  it("accepts the local Convex storage endpoint", () => {
    expect(isLocalStorageUrl("http://127.0.0.1:3210/api/storage/abc-123", 3210)).toBe(true);
  });

  it("refuses look-alikes a prefix check let through", () => {
    for (const url of [
      "http://127.0.0.1@evil.com/x.command",
      "http://127.0.0.1.evil.com/api/storage/x",
      "http://127.0.0.1:9999/api/storage/x",
      "http://127.0.0.1:3210/api/other",
      "https://127.0.0.1:3210/api/storage/x",
      "http://user:pw@127.0.0.1:3210/api/storage/x",
    ]) {
      expect(isLocalStorageUrl(url, 3210)).toBe(false);
    }
  });
});
